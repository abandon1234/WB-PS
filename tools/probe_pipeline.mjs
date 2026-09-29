/**
 * 流水线分步诊断：定位「哪一步慢 / 卡住」。
 *
 *   node tools/probe_pipeline.mjs [--base http://127.0.0.1:8777]
 *
 * 与 verify_cache 的区别：那个是断言"对不对"，这个是回答"卡在哪"。
 * 超时不代表失败 —— 拿到最后一步就是答案。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const BASE = arg('base', 'http://127.0.0.1:8777');
// 随机端口：上次跑崩时残留的浏览器仍占着固定端口，会导致下次静默起不来
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 120000);
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面执行出错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async waitFor(expr, timeout = 30000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) { /* 导航中 */ }
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  }
}

async function httpText(url, timeout = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try { return await (await fetch(url, { signal: ac.signal })).text(); } finally { clearTimeout(t); }
}

async function launch() {
  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge / Chrome');
  const profile = path.join(os.tmpdir(), `wb-probe-${Date.now()}`);
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      const list = JSON.parse(await httpText(`http://127.0.0.1:${DEBUG_PORT}/json/list`));
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return { child, profile, wsUrl: page.webSocketDebuggerUrl };
    } catch (_) { /* 还没起 */ }
    await sleep(400);
  }
  child.kill();
  throw new Error('调试端口未就绪');
}

const connect = (wsUrl) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('open', () => resolve(ws));
  ws.addEventListener('error', (e) => reject(new Error(`WebSocket 失败: ${e.message}`)));
});

(async function main() {
  console.log('='.repeat(72));
  console.log(`流水线分步诊断   ${BASE}`);
  console.log('='.repeat(72));

  try { await httpText(`${BASE}/engine-test.html`, 5000); } catch (_) {
    console.error('目标不可达，先跑 node tools/serve_dev.mjs --port 8777');
    process.exit(1);
  }

  const { child, profile, wsUrl } = await launch();
  const cdp = new CDP(await connect(wsUrl));

  const errors = [];
  const renderLog = [];
  const styleLog = [];
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(
    p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown'));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const txt = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (txt.startsWith('[render]')) renderLog.push(txt);
    else if (txt.startsWith('[style]')) styleLog.push(txt);
    else if (p.type === 'error') errors.push(txt);
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  try {
    await cdp.send('Page.navigate', { url: `${BASE}/engine-test.html` });
    await cdp.waitFor('!!window.__WB__', 30000, '自检页就绪');
    await cdp.waitFor('!!navigator.serviceWorker.controller', 15000, 'SW 接管页面');

    console.log('\n预热模型（首次约 40MB）…');
    const t0 = Date.now();
    await cdp.evaluate('window.__WB__.warm()');
    console.log(`  完成，${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // 逐步骤单独调用：每步一个 CDP 请求，谁超时谁就是元凶。
    // 好处是页面即便被某步卡死，前面已完成步骤的耗时仍然拿得到。
    console.log('\n逐步骤诊断…\n');
    const T = 'window.__T__';

    const ev = async (label, expr, timeout = 60000) => {
      const t0 = Date.now();
      const run = cdp.evaluate(expr)
        .then((r) => ({ ok: true, r }))
        .catch((e) => ({ ok: false, e: String(e.message) }));
      const guard = new Promise((r) => setTimeout(() => r({ ok: false, e: 'TIMEOUT' }), timeout));
      const res = await Promise.race([run, guard]);
      const ms = Date.now() - t0;
      const detail = res.ok
        ? JSON.stringify(res.r ?? null).slice(0, 160)
        : String(res.e).slice(0, 160);
      console.log(`  ${res.ok ? 'PASS' : 'FAIL'}  ${label.padEnd(12)} ${String(ms).padStart(7)}ms  ${detail}`);
      return res;
    };

    await ev('setup', `(async () => {
      const W = window.__WB__;
      const eng = await W.ensureEngine();
      window.__T__ = { eng };
      const img = await W.loadTestImage();
      const id = W.pullImageData(img).imageData;
      window.__T__.bgr = W.mod.imageDataToBgrMat(eng.cv, id);
      return window.__T__.bgr.cols + 'x' + window.__T__.bgr.rows;
    })()`, 120000);

    await ev('detect', `(async () => {
      const mod = await import('/engine/index.js');
      ${T}.items = await mod.detect(${T}.eng.cv, ${T}.eng.ocr, ${T}.bgr, {});
      return ${T}.items.length + ' 块';
    })()`, 120000);

    await ev('style-1', `(async () => {
      const { analyzeMany } = await import('/engine/style.js');
      const s = analyzeMany(${T}.eng.cv, ${T}.bgr, [${T}.items[0]])[0].style;
      return '字号 ' + s.font_size + ' / 背景 ' + s.bg_type + ' / 笔宽 ' + s.stroke_width;
    })()`);

    await ev('style-all', `(async () => {
      window.__STYLE_DEBUG__ = true;
      const { analyzeMany } = await import('/engine/style.js');
      analyzeMany(${T}.eng.cv, ${T}.bgr, ${T}.items);
      window.__STYLE_DEBUG__ = false;
      return ${T}.items.length + ' 块';
    })()`);

    await ev('erase-1', `(async () => {
      const { erase } = await import('/engine/erase.js');
      const r = erase(${T}.eng.cv, ${T}.bgr, ${T}.items[0].rect, ${T}.items[0].style, {});
      const info = 'method=' + r.meta.method + ' residual=' + r.meta.residual;
      r.image.delete();
      return info;
    })()`);

    // render 内部有几个重活：字体匹配（22 个候选各渲染一遍）、笔画校准（反复重绘）、
    // 清晰度匹配（高斯）。用开关逐个关掉，二分出到底是哪块慢。
    const MK = `{ match_source: ${T}.bgr, source_text: ${T}.items[0].text }`;
    const R1 = `[0].rect, '无痕改字', ${T}.items[0].style`;

    await ev('render-min', `(async () => {
      const { render } = await import('/engine/render.js');
      const r = render(${T}.eng.cv, ${T}.eng.fonts, ${T}.bgr, ${T}.items${R1},
        { family: 'sans-serif', auto_family: false, match_stroke: false, match_sharpness: false });
      const info = 'size=' + r.font_size + ' family=' + r.family;
      r.image.delete();
      return info;
    })()`);

    await ev('r+stroke', `(async () => {
      const { render } = await import('/engine/render.js');
      const r = render(${T}.eng.cv, ${T}.eng.fonts, ${T}.bgr, ${T}.items${R1},
        { family: 'sans-serif', auto_family: false, match_stroke: true, match_sharpness: false,
          stroke_width: 3, match_source: ${T}.bgr, source_text: ${T}.items[0].text });
      const info = 'stroke=' + JSON.stringify(r.stroke);
      r.image.delete();
      return info;
    })()`);

    await ev('cands', `(async () => {
      const fonts = ${T}.eng.fonts;
      const text = ${T}.items[0].text;
      const cands = fonts.candidates(text, 22);
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const ctx = c.getContext('2d');
      const out = [];
      for (const f of cands) {
        try {
          ctx.font = '400 180px ' + fonts.cssFor(f);
          out.push(f + '=' + Math.round(ctx.measureText(text).width));
        } catch (e) { out.push(f + '=ERR'); }
      }
      return { text, n: cands.length, widths: out.join('  ') };
    })()`);

    // 注意：不要在这里调 textMetrics —— 它会把主线程卡死，
    // 之后连"创建 canvas"都执行不了，后续所有探针都会假超时。
    // 先跑下面的原子探针定位，再单独处理 textMetrics。

    // 拆成独立调用：任一步卡死，前面已完成步的结果依然拿得到
    const CV = `${T}.eng.cv`;
    await ev('a1-canvas', `(() => {
      const c = document.createElement('canvas');
      c.width = 1620; c.height = 540;
      window.__TM__ = { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
      return c.width + 'x' + c.height;
    })()`, 20000);

    await ev('a2-font', `(() => {
      const ctx = window.__TM__.ctx;
      ctx.font = '400 180px sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      return ctx.font;
    })()`, 20000);

    await ev('a3-fillText', `(() => {
      window.__TM__.ctx.fillText('产品使用说明书', 180, 330);
      return 'ok';
    })()`, 20000);

    await ev('a4-getImageData', `(() => {
      const d = window.__TM__.ctx.getImageData(0, 0, 1620, 540);
      window.__TM__.img = d;
      return d.data.length;
    })()`, 20000);

    await ev('a5-scan', `(() => {
      const d = window.__TM__.img.data;
      let c = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) c++;
      return 'ink=' + c;
    })()`, 20000);

    await ev('a6-buildMat', `(() => {
      const cv = ${CV};
      const m = new cv.Mat(180, 1260, cv.CV_8UC1);
      for (let i = 0; i < 180 * 1260; i++) m.data[i] = (i % 7 === 0) ? 255 : 0;
      window.__TM__.m = m;
      return m.rows + 'x' + m.cols;
    })()`, 20000);

    await ev('a7-distanceT', `(() => {
      const cv = ${CV};
      const dt = new cv.Mat();
      cv.distanceTransform(window.__TM__.m, dt, cv.DIST_L2, 5);
      window.__TM__.dt = dt;
      return 'len=' + dt.data.length;
    })()`, 25000);

    await ev('a8-collect', `(() => {
      const dd = window.__TM__.dt.data;
      const v = [];
      for (let i = 0; i < dd.length; i++) if (dd[i] > 0) v.push(dd[i]);
      return 'n=' + v.length;
    })()`, 20000);

    await ev('r+match', `(async () => {
      window.__RENDER_DEBUG__ = true;
      const { render } = await import('/engine/render.js');
      const r = render(${T}.eng.cv, ${T}.eng.fonts, ${T}.bgr, ${T}.items${R1},
        { family: null, auto_family: true, match_stroke: false, match_sharpness: false, ...${MK} });
      const info = 'family=' + r.family + ' matched=' + JSON.stringify(r.matched).slice(0, 90);
      r.image.delete();
      window.__RENDER_DEBUG__ = false;
      return info;
    })()`, 45000);

    // 打点走 console 推送，主线程被卡死也收得到 —— 最后一行就是元凶
    if (styleLog.length) {
      console.log(`\n  样式打点（共 ${styleLog.length} 条，显示前 12 条）：`);
      styleLog.slice(0, 12).forEach((l) => console.log(`      ${l}`));
    }
    if (renderLog.length) {
      console.log(`\n  render 打点（共 ${renderLog.length} 条，显示最后 12 条）：`);
      renderLog.slice(-12).forEach((l) => console.log(`      ${l}`));
    }

    await ev('apply', `(async () => {
      const mod = await import('/engine/index.js');
      const edits = {};
      ${T}.items.slice(0, 2).forEach((it, i) => {
        edits[String(it.id)] = { text: i === 0 ? '无痕改字' : 'ABCdef123' };
      });
      const r = mod.applyEdits(${T}.eng.cv, ${T}.eng.fonts, ${T}.bgr, ${T}.items, edits);
      const info = '擦除 ' + r.stats.erased + ' 重绘 ' + r.stats.rendered;
      r.image.delete();
      return info;
    })()`);

    if (errors.length) {
      console.log('\n页面错误：');
      [...new Set(errors)].slice(0, 10).forEach((e) => console.log(`  ${String(e).split('\n')[0]}`));
    }
  } catch (err) {
    console.error('\n中断：', err.message);
    if (errors.length) {
      console.error('页面错误：');
      [...new Set(errors)].slice(0, 10).forEach((e) => console.error(`  ${String(e).split('\n')[0]}`));
    }
    process.exitCode = 1;
  } finally {
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})();
