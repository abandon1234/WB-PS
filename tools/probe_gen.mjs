/**
 * 前端流式生成的端到端验证（不消耗中转站额度）
 *
 * 做法：本地起一个假上游，说同一套 NDJSON 协议（start → tick… → done），
 * 然后用 CDP 的 Fetch 拦截把页面的 /api/image/generate 改写到本地这个地址。
 * 这样能真实验证前端的三件事：
 *   1. 一行一个 JSON 的解析（含一次收到多行、以及跨 chunk 切断的情况）
 *   2. 心跳驱动的"已等待 Ns"进度展示
 *   3. done 之后把结果图渲染出来（含 data_url 解码、作品库落盘）
 *
 *   node tools/probe_gen.mjs [--base https://ps.ysw69.dpdns.org] [--profile <dir>]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'https://ps.ysw69.dpdns.org').replace(/\/$/, '');
const fixedProfile = arg('profile', '');
const PORT = 9352;
const CDP_PORT = 9353;
const TICKS = 6;                       // 每 1 秒一行心跳 → 约 6 秒
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASS = [], FAIL = [];
const check = (name, ok, detail = '') => {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

/* ---------------------------------------------------------------- 假数据 */
// 结果图用项目里现成的样例图（真实尺寸，能让渲染路径走全）
const png = fs.readFileSync('samples/test_card.png');
const dataUrl = 'data:image/png;base64,' + png.toString('base64');

/* ---------------------------------------------------------------- CDP */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        (this.listeners.get(m.method) || []).forEach((fn) => fn(m.params));
      }
    });
  }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 300000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 60000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) {}
      await sleep(250);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-gen-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { child.kill(); console.error('浏览器未就绪'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

// 页面侧异常/日志都收集起来：不然只看到"没反应"，不知道卡在哪一步
const pageLog = [];
cdp.on('Runtime.exceptionThrown', (p) => pageLog.push('EXC ' + String(
  p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).split('\n')[0]));
cdp.on('Runtime.consoleAPICalled', (p) => {
  const t = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
  if (p.type === 'error' || p.type === 'warning') pageLog.push(`${p.type} ${t}`);
});
// 网络层失败原因（CORS / 混合内容 / 连接被拒 都记在这）
await cdp.send('Network.enable');
cdp.on('Network.loadingFailed', (p) => {
  if (p.type === 'Fetch' || p.type === 'XHR') {
    console.log(`      ✗ 网络失败：${p.errorText}（${p.type}）`);
  }
});
cdp.on('Network.requestWillBeSent', (p) => {
  if (String(p.request.url).includes('9352') || String(p.request.url).includes('image/generate')) {
    console.log(`      → ${p.request.method} ${p.request.url}`);
  }
});

// 在页面里伪造一条 NDJSON 流来替换生成请求。
//
// 试过两条弯路：CDP 的 Fetch 域拦截（请求被 pause 住但收不到事件，页面一直转圈）、
// 本地 http 假上游（https 页面发 http 请求属混合内容，被浏览器直接拦掉）。
// 最终用"改写 fetch + 在页面内构造 ReadableStream"：不走网络，但起止时序、
// 分块节奏、NDJSON 协议全都和真实服务端一致，零成本还没跨域问题。
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const orig = window.fetch.bind(window);
    const PNG = ${JSON.stringify(dataUrl)};
    window.__genRewritten = 0;
    window.fetch = (url, opt) => {
      const s = typeof url === 'string' ? url : (url && url.url) || '';
      if (!s.includes('/api/image/generate')) return orig(url, opt);
      window.__genRewritten++;
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(c) {
          const line = (o) => c.enqueue(enc.encode(JSON.stringify(o) + '\\n'));
          line({ type: 'start', timeout: 300, elapsed: 0, heartbeat_ms: 1000 });
          for (let i = 1; i <= ${TICKS}; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            line({ type: 'tick', elapsed: i });
          }
          line({ type: 'done', ok: true, count: 1, elapsed: ${TICKS}, model: 'mock-model',
                 images: [{ url: 'https://example.test/mock.png', revised_prompt: '',
                            bytes: ${png.length}, data_url: PNG }],
                 tool: 'create', tool_name: '自由生成',
                 provider: { name: '假上游', model: 'mock-model' } });
          c.close();
        },
      });
      return Promise.resolve(new Response(body, {
        status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      }));
    };
  })()`,
});

const seen = [];   // 记录 loadingSub 的取值变化，用来证明心跳驱动了界面

try {
  console.log('\n[1] 打开生成页');
  await cdp.send('Page.navigate', { url: `${BASE}/image` });
  await cdp.waitFor("!!document.getElementById('btnGenerate')", 40000, '生成页就绪');
  const ready = await cdp.evaluate(`(() => {
    const el = document.getElementById('statusText') || document.getElementById('siteStatus');
    return document.body.innerText.includes('生成') || !!el;
  })()`);
  check('生成页加载', ready === true);

  console.log('\n[2] 填提示词并点生成');
  // 页面加载后有一次异步的"草稿水合"，会把输入框重写成上次保存的内容，
  // 而且它可能**刚好在点击那一刻**完成 —— 表现成"点了没反应"（踩过两次）。
  // 所以这里：先等页面稳定 → 填值并校验 → 点击 → 确认真的启动了，不行就重来。
  await sleep(3000);

  const PROMPT = '一只趴在窗台的橘猫，流式测试';
  const fillPrompt = async () => {
    for (let i = 0; i < 4; i++) {
      await cdp.evaluate(`(() => {
        const el = document.getElementById('prompt');
        el.value = ${JSON.stringify(PROMPT)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value.length;
      })()`, false);
      await sleep(400);
      const n = await cdp.evaluate("document.getElementById('prompt').value.length").catch(() => 0);
      if (n > 0) return n;
    }
    return 0;
  };
  const started = async () => cdp.evaluate(`(() => {
    const el = document.getElementById('stateLoading');
    const visible = el && !el.hidden && getComputedStyle(el).display !== 'none';
    return !!(visible || (window.__genRewritten > 0));
  })()`).catch(() => false);

  let attempts = 0;
  let okStart = false;
  for (attempts = 1; attempts <= 5 && !okStart; attempts++) {
    const n = await fillPrompt();
    if (!n) { console.log(`      第 ${attempts} 次：提示词仍为空`); continue; }
    await cdp.evaluate("document.getElementById('btnGenerate').click()", false);
    await sleep(1800);
    okStart = await started();
    if (!okStart) console.log(`      第 ${attempts} 次点击没启动（草稿水合覆盖了输入），重试…`);
  }
  check('点生成后确实进入生成流程', okStart === true, `试了 ${attempts - 1} 次`);

  // 先看一眼点击后的即时状态：改写有没有装上、提示词是否真的填进去了、
  // 生成函数是不是前置校验就 return 了
  const diag = await cdp.evaluate(`(() => ({
    patched: typeof window.__genRewritten,
    rewritten: window.__genRewritten,
    prompt: (document.getElementById('prompt') || {}).value || '',
    loadingVisible: (() => {
      const el = document.getElementById('stateLoading');
      if (!el) return null;
      return !el.hidden && getComputedStyle(el).display !== 'none';
    })(),
    toast: (document.getElementById('toastWrap') || {}).innerText || '',
    sub: (document.getElementById('loadingSub') || {}).textContent || '',
  }))()`);
  console.log(`      诊断：改写标记=${diag.patched} 次数=${diag.rewritten} 载入中可见=${diag.loadingVisible}`);
  console.log(`      sub=「${diag.sub.slice(0, 60)}」`);

  // 采样 loadingSub，观察「已等待 Ns」是否随心跳递增。
  // 采样间隔要明显小于心跳间隔（这里 1 秒一行心跳，用 300ms 采），
  // 否则同一秒内的多次更新会被下一次采样覆盖掉，看起来像"只更新了一次"。
  const t0 = Date.now();
  let lastText = '';
  let lastImgCheck = 0;
  const t0Fill = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(300);
    let s = null;
    try {
      s = await cdp.evaluate(`(() => {
        const sub = document.getElementById('loadingSub');
        return { text: sub ? sub.textContent : '' };
      })()`);
    } catch (_) { continue; }
    if (s && s.text && s.text !== lastText) {
      lastText = s.text;
      seen.push(`${((Date.now() - t0) / 1000).toFixed(1)}s: ${s.text}`);
    }
    // 图片检查比文案检查重，降到每秒一次
    if (Date.now() - lastImgCheck > 900) {
      lastImgCheck = Date.now();
      const done = await cdp.evaluate(`(() => {
        const all = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 80 && i.offsetParent);
        const err = document.getElementById('stateError');
        const errShown = err && !err.hidden && getComputedStyle(err).display !== 'none';
        return { bigImgs: all.map((i) => i.naturalWidth + 'x' + i.naturalHeight),
                 errShown: !!errShown,
                 errMsg: (document.getElementById('errMsg') || {}).textContent || '' };
      })()`).catch(() => null);
      if (done && (done.bigImgs.length || done.errShown)) {
        seen.push(`END ${JSON.stringify(done)}`);
        break;
      }
    }
  }
  console.log(`      （采样 ${((Date.now() - t0Fill) / 1000).toFixed(0)}s，共 ${seen.length} 次变化）`);
  seen.forEach((l) => console.log(`        ${l.slice(0, 110)}`));

  const waitTicks = seen.filter((l) => /已等待/.test(l));
  check('收到心跳并在界面显示「已等待 Ns」', waitTicks.length >= 3,
    `${waitTicks.length} 次更新；样例：${waitTicks.slice(0, 3).map((s) => (s.split(': ')[1] || '').slice(-12)).join(' / ')}`);
  check('等待秒数确实在递增（不是写死的文案）',
    (() => {
      const ns = waitTicks.map((l) => Number((l.match(/已等待 (\d+)s/) || [])[1])).filter((n) => Number.isFinite(n));
      return ns.length >= 3 && ns[ns.length - 1] > ns[0];
    })(),
    waitTicks.slice(-2).map((s) => (s.match(/已等待 \d+s/) || [''])[0]).join(' → '));

  console.log('\n[3] 结果渲染');
  const fin = await cdp.evaluate(`(() => {
    const all = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 80);
    const big = all.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
    const err = document.getElementById('stateError');
    const errShown = err && !err.hidden && getComputedStyle(err).display !== 'none';
    const toast = document.getElementById('toastWrap') ? document.getElementById('toastWrap').innerText : '';
    return {
      imgs: all.map((i) => i.naturalWidth + 'x' + i.naturalHeight),
      natW: big ? big.naturalWidth : 0, natH: big ? big.naturalHeight : 0,
      src: big ? String(big.src || '').slice(0, 40) : '',
      errShown: !!errShown,
      errMsg: (document.getElementById('errMsg') || {}).textContent || '',
      toast: toast.slice(0, 80),
      rewritten: window.__genRewritten || 0,
    };
  })()`);
  check('结果图渲染出来了', fin.natW > 0,
    `${fin.natW}×${fin.natH} · 页面共 ${fin.imgs.length} 张大图 · ${fin.src}…`);
  check('没有走到错误态', fin.errShown === false, fin.errMsg || '（无错误）');
  check('请求确实被改写到了假上游', fin.rewritten >= 1, `改写 ${fin.rewritten} 次`);

  console.log('\n' + '='.repeat(74));
  console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
  if (FAIL.length) FAIL.forEach((f) => console.log(`  ✗ ${f}`));
  if (pageLog.length) {
    console.log('页面侧日志（前 10 条）：');
    pageLog.slice(0, 10).forEach((l) => console.log(`  ${l.slice(0, 160)}`));
  } else {
    console.log('页面侧无错误日志');
  }
  console.log('='.repeat(74));
  process.exitCode = FAIL.length ? 1 : 0;
} catch (err) {
  console.error('\n验证中断：', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
