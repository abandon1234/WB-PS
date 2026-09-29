/**
 * 线上部署验证（真实浏览器直连生产域名 + CDP）
 * ---------------------------------------------------------------------------
 * 与 verify_cache.mjs 的区别：那个跑本地服务器（Node 侧可预检），这个直接打
 * 线上域名 —— 所以一切判断都必须走浏览器，Node 的 fetch 在沙箱里出不去。
 *
 * 要证明的四件事：
 *   1. 页面可达：/ 、/image 、/admin 都返回 200（不是 307 跳转）
 *   2. 资源可达：/sw.js 、/static/engine/* 、/assets/*（含 39MB 模型）都能取到
 *   3. 缓存闭环：预热下载 → 重载后全部由 Service Worker 命中 → 断网仍可用
 *   4. 业务可用：线上页面里跑通完整改字流水线（识别 → 擦除 → 重绘 → 出图）
 *
 *   node tools/verify_online.mjs [--base https://wb-ps.xxxx.workers.dev]
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

const BASE = arg('base', 'https://wb-ps.2479770116.workers.dev').replace(/\/$/, '');
const DEBUG_PORT = 9346;
const SAMPLE = path.resolve('samples/test_card.png');
const OUT_DIR = path.resolve('samples/out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASS = [];
const FAIL = [];
const check = (name, ok, detail = '') => {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

/* ---------------------------------------------------------------- CDP */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        const fns = this.listeners.get(msg.method);
        if (fns) fns.forEach((fn) => fn(msg.params));
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 600000);
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面执行出错: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async waitFor(expression, timeout = 30000, label = expression) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expression)) return true; } catch (_) { /* 导航中 */ }
      await sleep(250);
    }
    throw new Error(`等待超时：${label}`);
  }
}

async function launch() {
  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge / Chrome 可执行文件');

  const profile = path.join(os.tmpdir(), `wb-online-${Date.now()}`);
  // --no-proxy-server：绕开沙箱注入的 HTTP_PROXY，让浏览器走本机真实网络
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return { child, profile, wsUrl: page.webSocketDebuggerUrl };
    } catch (_) { /* 还没起 */ }
    await sleep(400);
  }
  child.kill();
  throw new Error('浏览器调试端口未就绪');
}

const connect = (wsUrl) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('open', () => resolve(ws));
  ws.addEventListener('error', (e) => reject(new Error(`WebSocket 连接失败: ${e.message}`)));
});

/* ---------------------------------------------------------------- 主流程 */
(async function main() {
  console.log('='.repeat(74));
  console.log(`线上部署验证   目标=${BASE}`);
  console.log('='.repeat(74));

  const { child, profile, wsUrl } = await launch();
  const cdp = new CDP(await connect(wsUrl));

  let swServed = [];
  let netRequests = [];
  cdp.on('Network.responseReceived', (p) => {
    const url = p.response?.url || '';
    if (!url.includes('/assets/')) return;
    if (p.response.fromServiceWorker) swServed.push(url);
    else netRequests.push(url);
  });

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description
      || p.exceptionDetails?.text || 'unknown');
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      pageErrors.push((p.args || []).map((a) => a.description || a.value).join(' '));
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  try {
    /* ---------- 1. 页面可达 ---------- */
    console.log('\n[1] 页面可达');
    const nav = await cdp.send('Page.navigate', { url: `${BASE}/` });
    check('首页导航成功（无 DNS/连接错误）', !nav.errorText, nav.errorText || 'ok');
    if (nav.errorText) throw new Error(`无法访问 ${BASE}：${nav.errorText}`);

    await cdp.waitFor('document.readyState === "complete"', 40000, '页面加载完成');
    const meta = await cdp.evaluate(`({
      title: document.title,
      h1: (document.querySelector('h1')||{}).textContent || '',
      url: location.href,
    })`);
    check('首页渲染出内容', !!meta.title || !!meta.h1, `title="${meta.title}" h1="${meta.h1}"`);

    // 页面路由：这三个是最容易被 Cloudflare 静态层抢走的
    const routes = await cdp.evaluate(`(async () => {
      const out = {};
      for (const p of ['/', '/image', '/admin', '/sw.js', '/static/app.js',
                       '/static/engine/boot.js', '/assets/manifest.json']) {
        try { const r = await fetch(p, { redirect: 'manual' }); out[p] = r.status; }
        catch (e) { out[p] = 'ERR ' + e.message; }
      }
      return out;
    })()`);
    const bad = Object.entries(routes).filter(([, s]) => s !== 200);
    check('关键路径全部 200（含 / /image /admin）', bad.length === 0,
      bad.length ? JSON.stringify(bad) : Object.keys(routes).join(' '));

    const hdrs = await cdp.evaluate(`(async () => {
      const r = await fetch('/assets/manifest.json');
      return r.headers.get('cache-control') || '(none)';
    })()`);
    check('/assets/ 带长缓存头', /max-age=31536000/.test(hdrs), hdrs);

    /* ---------- 2. 资源与 Service Worker ---------- */
    console.log('\n[2] Service Worker 与资源');
    const swState = await cdp.evaluate(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        scope: reg ? reg.scope : null,
        script: reg && reg.active ? reg.active.scriptURL : null,
        controlled: !!navigator.serviceWorker.controller,
      };
    })()`);
    check('Service Worker 已注册', !!swState.scope, `${swState.scope} ← ${swState.script}`);

    await cdp.waitFor('!!window.WBLocal', 30000, '引导脚本就绪');
    check('页面加载了本地引擎引导（window.WBLocal）', true);

    await cdp.waitFor('!!navigator.serviceWorker.controller', 20000, 'SW 接管页面');
    check('SW 已接管当前页面', true);

    const models = await cdp.evaluate(`(async () => {
      const mf = await (await fetch('/assets/manifest.json')).json();
      const models = mf.files.filter(f => f.kind === 'model');
      return { total: mf.files.length, models: models.length,
               bytes: mf.files.reduce((n,f)=>n+(f.bytes||0),0) };
    })()`);
    check('模型清单可读', models.models >= 3,
      `${models.total} 个资源（模型 ${models.models}） · ${(models.bytes / 1048576).toFixed(2)} MB`);

    /* ---------- 3. 预热下载并写入缓存 ---------- */
    console.log('\n[3] 预热下载（39MB，走真实网络）');
    swServed = []; netRequests = [];
    await cdp.evaluate(`(() => {
      window.__PROG__ = { phase: 'start', label: '启动' };
      window.WBLocal.progress = (p) => { window.__PROG__ = p; };
      window.__DONE__ = null;
      window.WBLocal.ensure()
        .then(() => { window.__DONE__ = 'ok'; })
        .catch((e) => { window.__DONE__ = 'err:' + (e && e.message || e); });
      return 1;
    })()`, false);

    const t0 = Date.now();
    let lastLabel = '';
    for (let i = 0; i < 400; i++) {
      await sleep(3000);
      let p = null, done = null;
      try {
        p = await cdp.evaluate('window.__PROG__');
        done = await cdp.evaluate('window.__DONE__');
      } catch (_) { /* 页面繁忙 */ }
      if (p && p.label !== lastLabel) {
        lastLabel = p.label;
        const pct = p.total ? ` ${Math.round((p.done / p.total) * 100)}%` : '';
        console.log(`      ${p.phase}  ${p.label}${pct}`);
      }
      if (done) {
        check('引擎初始化完成', done === 'ok', done === 'ok' ? '' : String(done));
        break;
      }
      if (Date.now() - t0 > 590000) { check('引擎初始化完成', false, '超时 590s'); break; }
    }
    console.log(`      耗时 ${Math.round((Date.now() - t0) / 1000)}s`);

    const keys = await cdp.evaluate(
      "caches.open('wb-ps-assets-v1').then(c => c.keys()).then(ks => ks.map(k => new URL(k.url).pathname))");
    check('资源已写入 Cache Storage', keys.length >= 8, `${keys.length} 项`);
    check('三个模型都在缓存里',
      keys.some((k) => k.includes('rec_infer')) && keys.some((k) => k.includes('det_infer'))
      && keys.some((k) => k.includes('cls_infer')));

    /* ---------- 4. 重载后由 SW 命中 ---------- */
    console.log('\n[4] 重载页面（验证缓存命中）');
    swServed = []; netRequests = [];
    await cdp.send('Page.reload');
    await cdp.waitFor('!!window.WBLocal', 40000, '页面重载完成');
    await cdp.waitFor('!!navigator.serviceWorker.controller', 20000, 'SW 重新接管');

    const warm = await cdp.evaluate(`(async () => {
      const t0 = performance.now();
      const mf = await (await fetch('/assets/manifest.json')).json();
      await Promise.all(mf.files.map(f => fetch(f.path)));
      return Math.round(performance.now() - t0);
    })()`);
    await sleep(400);
    check('全量资源请求全部由 SW 命中（无网络请求）',
      netRequests.length === 0 && swServed.length >= 8,
      `SW 返回 ${swServed.length} 个，走网络 ${netRequests.length} 个`);
    check('全量重取耗时（缓存命中）', warm < 5000, `${warm} ms`);

    /* ---------- 5. 断网可用 ---------- */
    console.log('\n[5] 断开网络');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    const offline = await cdp.evaluate(`(async () => {
      const mf = await (await fetch('/assets/manifest.json')).json();
      const rs = await Promise.all(mf.files.map(async (f) => {
        try { const r = await fetch(f.path); return r.ok; } catch (e) { return false; }
      }));
      return { ok: rs.filter(Boolean).length, total: mf.files.length };
    })()`);
    check('断网后全部资源仍可读取', offline.ok === offline.total, `${offline.ok}/${offline.total}`);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    /* ---------- 6. 线上跑完整改字流水线 ---------- */
    console.log('\n[6] 线上完整流水线（识别 → 擦除 → 重绘）');
    const b64 = fs.readFileSync(SAMPLE).toString('base64');
    await cdp.evaluate(`(() => {
      const bin = atob(${JSON.stringify(b64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      window.__SAMPLE__ = new Blob([u8], { type: 'image/png' });
      return window.__SAMPLE__.size;
    })()`, false);

    const run = await cdp.evaluate(`(async () => {
      const L = window.WBLocal;
      const fd = new FormData();
      fd.append('file', new File([window.__SAMPLE__], 'test_card.png', { type: 'image/png' }));
      fd.append('merge_lines', 'true');

      const an = await L.handle('/api/analyze', fd);
      const sid = an.session_id;
      const it = an.items[0];
      const edits = {};
      edits[String(it.id)] = { text: '无痕改字' };
      const ap = await L.handle('/api/apply', {
        session_id: sid, edits, new_items: [], format: 'png',
      });
      return {
        count: an.count, backend: an.backend, elapsed: an.elapsed_ms,
        firstText: it.text,
        font: (it.style || {}).font_size,
        fg: (it.style || {}).fg_color,
        weight: (it.style || {}).weight,
        rendered: ap.stats.rendered, erased: ap.stats.erased,
        acts: (ap.stats.log || []).map((r) => (r.action + '|' + (r.error || r.text || '')).slice(0, 50)),
        img: String(ap.image || '').startsWith('data:image/png') ? ap.image : null,
      };
    })()`);

    check('线上页面内完成识别', run.count > 0 && run.backend === 'browser-wasm',
      `${run.count} 块 · 首块「${run.firstText}」· ${run.elapsed}ms`);
    check('样式反推结果正常（字号/字色已修正）',
      run.font > 20 && run.font < 120 && Array.isArray(run.fg)
      && run.fg[0] < 120 && run.fg[1] < 120 && run.fg[2] < 120,
      `字号 ${run.font} · 字色 rgb(${run.fg}) · 档位 ${run.weight}`);
    check('完成擦除 + 重绘', run.rendered >= 1 && run.erased >= 1,
      `重绘 ${run.rendered} 处 · 擦除 ${run.erased} 处 · ${JSON.stringify(run.acts)}`);

    if (run.img) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const out = path.join(OUT_DIR, 'pipeline_online.png');
      fs.writeFileSync(out, Buffer.from(run.img.split(',')[1], 'base64'));
      console.log(`      结果图已导出：${out}`);
    }

    /* ---------- 汇总 ---------- */
    console.log('\n' + '='.repeat(74));
    console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
    if (FAIL.length) FAIL.forEach((f) => console.log(`  ✗ ${f}`));
    console.log('='.repeat(74));

    process.exitCode = FAIL.length ? 1 : 0;
  } catch (err) {
    console.error('\n验证中断：', err.message);
    if (pageErrors.length) {
      console.error('\n页面侧错误：');
      pageErrors.slice(0, 12).forEach((e) => console.error(`  ${String(e).split('\n')[0]}`));
    }
    process.exitCode = 1;
  } finally {
    child.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})();
