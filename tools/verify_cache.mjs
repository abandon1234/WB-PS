/**
 * 缓存闭环验证（真实浏览器 + CDP）
 * ---------------------------------------------------------------------------
 * 要证明的四件事：
 *   1. 首次访问：缓存是空的 → 预热下载 → 资源真的进了 Cache Storage
 *   2. 二次访问：页面重载后，模型请求由 Service Worker 命中缓存返回（不是走网络）
 *   3. 离线可用：断网后重新取全部资源，仍然全部成功
 *   4. 推理可用：引擎能从缓存加载模型并跑出识别结果
 *
 *   node tools/verify_cache.mjs [--base http://127.0.0.1:8777]
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
const DEBUG_PORT = 9344;
const W = 1280;
const H = 900;

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
      }, 300000);
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
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  }
}

async function httpText(url, timeout = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return await r.text();
  } finally { clearTimeout(t); }
}

async function launch() {
  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge / Chrome 可执行文件');

  const profile = path.join(os.tmpdir(), `wb-verify-${Date.now()}`);
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    'about:blank',
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
  throw new Error('浏览器调试端口未就绪');
}

const connect = (wsUrl) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('open', () => resolve(ws));
  ws.addEventListener('error', (e) => reject(new Error(`WebSocket 连接失败: ${e.message}`)));
});

/* ---------------------------------------------------------------- 主流程 */
(async function main() {
  console.log('='.repeat(72));
  console.log(`缓存闭环验证   目标=${BASE}`);
  console.log('='.repeat(72));

  try {
    await httpText(`${BASE}/static/engine-test.html`, 5000);
  } catch (err) {
    console.error(`目标不可达：${BASE}（先跑 node tools/serve_dev.mjs --port 8777）`);
    process.exit(1);
  }

  const { child, profile, wsUrl } = await launch();
  const cdp = new CDP(await connect(wsUrl));

  // 记录哪些请求是 Service Worker 直接返回的（这比看"有没有网速变化"可靠得多）
  let swServed = [];
  let netRequests = [];
  cdp.on('Network.responseReceived', (p) => {
    const url = p.response?.url || '';
    if (!url.includes('/assets/')) return;
    if (p.response.fromServiceWorker) swServed.push(url);
    else netRequests.push(url);
  });

  // 收集页面侧异常：模块加载/语法错误时，光等超时看不出所以然
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
    /* ---------- 1. 首次访问：缓存应为空 ---------- */
    console.log('\n[1] 首次访问');
    await cdp.send('Page.navigate', { url: `${BASE}/static/engine-test.html` });
    await cdp.waitFor('!!window.__WB__', 30000, '自检页就绪');
    await cdp.waitFor('!!navigator.serviceWorker.controller', 15000, 'SW 接管页面');

    const st0 = await cdp.evaluate('window.__WB__.store.status()');
    const models0 = st0.files.filter((f) => f.kind === 'model');
    check('首次访问时模型尚未缓存', models0.every((f) => !f.cached),
      `模型就绪 ${models0.filter((f) => f.cached).length}/${models0.length}，清单已预取 ${st0.ready.length} 项`);

    /* ---------- 2. 预热下载并写入缓存 ---------- */
    console.log('\n[2] 预热下载');
    swServed = []; netRequests = [];
    const st1 = await cdp.evaluate('window.__WB__.warm().then(() => window.__WB__.store.status())');
    check('预热后全部就绪', st1.complete === true,
      `就绪 ${st1.ready.length}/${st1.files.length}，${(st1.readyBytes / 1048576).toFixed(1)} MB`);

    const keys = await cdp.evaluate(
      "caches.open('wb-ps-assets-v1').then(c => c.keys()).then(ks => ks.map(k => new URL(k.url).pathname))");
    check('Cache Storage 里确有 8 个资源', keys.length >= 8, keys.join(', '));
    check('模型文件在缓存里',
      keys.some((k) => k.includes('rec_infer')) && keys.some((k) => k.includes('det_infer')));

    /* ---------- 3. 二次访问：模型请求应由 SW 命中 ---------- */
    console.log('\n[3] 二次访问（重载页面）');
    swServed = []; netRequests = [];
    await cdp.send('Page.reload');
    await cdp.waitFor('!!window.__WB__', 30000, '页面重载完成');
    await sleep(1200);

    const st2 = await cdp.evaluate('window.__WB__.store.status()');
    check('重载后缓存依然完整', st2.complete === true,
      `就绪 ${st2.ready.length}/${st2.files.length}`);

    // 主动把全部资源再取一遍，看这些请求是否全部由 SW 直接返回。
    // 这比"看有没有网速变化"可靠 —— fromServiceWorker 是浏览器给的明确标记。
    const warm = await cdp.evaluate(`(async () => {
      const t0 = performance.now();
      await Promise.all((await window.__WB__.store.manifest()).files.map(f => fetch(f.path)));
      return Math.round(performance.now() - t0);
    })()`);
    await sleep(300);
    check('全部资源请求都由 SW 命中缓存（无网络请求）',
      netRequests.length === 0 && swServed.length >= 8,
      `SW 返回 ${swServed.length} 个，走网络 ${netRequests.length} 个`);
    check('全量重新取资源耗时（缓存命中）', warm < 5000, `${warm} ms`);

    /* ---------- 4. 离线可用 ---------- */
    console.log('\n[4] 断开网络');
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
    check('断网后全部资源仍可读取（全部来自缓存）',
      offline.ok === offline.total, `${offline.ok}/${offline.total}`);

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    /* ---------- 5. 本地推理 ---------- */
    console.log('\n[5] 本地推理');
    const ocr = await cdp.evaluate(`(async () => {
      try {
        await window.__WB__.runOcr();
        return { ok: true, text: document.getElementById('ocrStatus').textContent };
      } catch (e) { return { ok: false, text: String(e && e.message || e) }; }
    })()`);
    check('引擎从缓存加载模型并完成识别',
      ocr.ok === true && !/失败/.test(ocr.text), ocr.text);

    /* ---------- 6. 完整流水线 ---------- */
    console.log('\n[6] 完整流水线（识别 → 样式 → 擦除 → 重绘）');
    const pipe = await cdp.evaluate(`(async () => {
      try {
        await window.__WB__.runPipeline();
        const c = document.getElementById('result');
        return { ok: true,
          text: document.getElementById('pipeStatus').textContent,
          log: document.getElementById('log').textContent,
          shot: c && c.width ? c.toDataURL('image/png') : null };
      } catch (e) { return { ok: false, text: String(e && e.message || e) }; }
    })()`);
    const pipelineOk = pipe.ok && !/失败/.test(pipe.text);
    check('完整流水线跑通', pipelineOk, pipe.text);

    // 把改字结果落盘，人工也能复核
    if (pipe.shot) {
      const out = path.resolve('samples/out/pipeline_result.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(pipe.shot.split(',')[1], 'base64'));
      console.log(`      结果图已导出：${out}`);
    }

    if (pipe.log) {
      const lines = pipe.log.split('\n').filter((l) =>
        l.includes('分析：') || l.includes('首块样式') || l.includes('改字：') || l.includes('  #'));
      lines.slice(-8).forEach((l) => console.log(`      ${l.trim()}`));
      const errors = (pipe.log.match(/✗/g) || []).length;
      check('没有重绘报错', errors === 0, errors ? `${errors} 条错误` : '');
    }

    /* ---------- 7. 前端页面集成 ---------- */
    console.log('\n[7] 前端页面集成（真实 / 页面 + 本地引擎）');
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await cdp.waitFor('!!window.WBLocal', 25000, '引导脚本就绪');

    const fe = await cdp.evaluate(`(async () => {
      const L = window.WBLocal;
      const blob = await (await fetch('/samples/test_card.png')).blob();
      const fd = new FormData();
      fd.append('file', new File([blob], 'test_card.png', { type: 'image/png' }));
      fd.append('merge_lines', 'true');

      const an = await L.handle('/api/analyze', fd);
      const sid = an.session_id;
      const firstId = an.items[0].id;

      // 顺序刻意保持「先 preview、后 apply」：这正是当初暴露缓存污染的场景。
      // 同一段文字被 preview 渲染过一次后，apply 会命中同一个字形掩膜缓存，
      // 修复前这里会因缓存对象已被释放而报 Mat.data 错。
      const pv = await L.handle('/api/preview', {
        session_id: sid, id: firstId, edit: { text: '改一处看看' },
      });
      const edits = {};
      edits[String(firstId)] = { text: '改一处看看' };
      const ap = await L.handle('/api/apply', {
        session_id: sid, edits, new_items: [], format: 'png',
      });

      return {
        count: an.count, backend: an.backend,
        firstText: an.items[0].text,
        firstFont: (an.items[0].style || {}).font_size,
        previewRegion: pv.region, previewPatch: String(pv.patch || '').slice(0, 22),
        previewWarnings: (pv.info && pv.info.warnings || []).length,
        applyRendered: ap.stats.rendered, applyBytes: ap.bytes,
        applyErased: ap.stats.erased,
        applyActions: (ap.stats.log || []).map((r) => (r.action + '|' + (r.error || r.text || '')).slice(0, 60)),
        firstId: String(firstId), editKeys: Object.keys(edits),
        applyIsDataUrl: String(ap.image || '').startsWith('data:image/png'),
        elapsed: an.elapsed_ms,
      };
    })()`);

    check('页面内本地引擎完成识别',
      fe.count > 0 && fe.backend === 'browser-wasm',
      `${fe.count} 块 · 首块「${fe.firstText}」字号 ${fe.firstFont} · ${fe.elapsed}ms`);
    check('局部预览返回补丁图',
      Array.isArray(fe.previewRegion) && fe.previewPatch.startsWith('data:image/png'),
      `region=${JSON.stringify(fe.previewRegion)} patch=${fe.previewPatch}…`);
    check('整图应用返回结果图',
      fe.applyRendered >= 1 && fe.applyIsDataUrl,
      `重绘 ${fe.applyRendered} 处 · 擦除 ${fe.applyErased} · ${(fe.applyBytes / 1024).toFixed(0)} KB`
      + ` · id=${fe.firstId} keys=${JSON.stringify(fe.editKeys)}`
      + ` · ${JSON.stringify(fe.applyActions)}`);

    /* ---------- 汇总 ---------- */
    console.log('\n' + '='.repeat(72));
    console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
    if (FAIL.length) FAIL.forEach((f) => console.log(`  ✗ ${f}`));
    console.log('='.repeat(72));

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
