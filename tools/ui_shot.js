/**
 * 界面截图工具（无头浏览器 + CDP）
 * ---------------------------------------------------------------------------
 * 环境里没有 Playwright 的 Chromium，但系统装了 Edge / Chrome。
 * 这里直接用 Node 22 内置的 WebSocket 连 Chrome DevTools Protocol 驱动它，
 * 好处是可以先注入数据（IndexedDB 作品库、管理会话）再截图，
 * 否则像"作品库画廊""后台仪表盘"这类需要登录/有数据的界面根本截不到。
 *
 * 用法：
 *   node tools/ui_shot.js                    # 全部截图
 *   node tools/ui_shot.js --base http://127.0.0.1:8000 --out samples/out
 *   node tools/ui_shot.js --password xxx     # 需要看后台登录后的界面时提供
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const BASE = arg('base', 'http://127.0.0.1:8000');
const OUT = path.resolve(arg('out', 'samples/out'));
const PASSWORD = arg('password', '');
const W = 1440;
const H = 900;
const PORT = 9333;

/* ---------------------------------------------------------------- CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
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
      }, 120000);
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面执行出错: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async waitFor(expression, timeout = 30000, label = expression) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (_) { /* 页面可能正在导航 */ }
      await sleep(220);
    }
    throw new Error(`等待超时：${label}`);
  }

  async goto(url, waitReady = true) {
    await this.send('Page.navigate', { url });
    if (waitReady) await sleep(900);
  }

  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const p = path.join(OUT, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    const kb = (fs.statSync(p).size / 1024).toFixed(0);
    console.log(`  ✓ ${file}  ${kb} KB`);
    return p;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function http(url, timeout = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return await r.text();
  } finally { clearTimeout(t); }
}

/* ---------------------------------------------------------------- 启动浏览器 */
async function launch() {
  const exe = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge / Chrome 可执行文件');

  const profile = path.join(os.tmpdir(), 'wb-ui-shot-' + Date.now());
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--no-proxy-server', '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  for (let i = 0; i < 60; i++) {
    try {
      const txt = await http(`http://127.0.0.1:${PORT}/json/list`);
      const list = JSON.parse(txt);
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) {
        return { child, profile, wsUrl: page.webSocketDebuggerUrl };
      }
    } catch (_) { /* 还没起来 */ }
    await sleep(400);
  }
  child.kill();
  throw new Error('浏览器调试端口未就绪');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + e.message)));
  });
}

/* ---------------------------------------------------------------- 播种脚本 */
const SEED = `(async () => {
  const samples = [
    ['生成一个小狗，坐在草地上，阳光明媚，高清摄影风格', '自由生成', ['#7ee04a', '#2f8f5b'], '1024x1024', true],
    ['未来城市夜景，赛博朋克风格，霓虹灯，电影质感', '自由生成', ['#8b5cf6', '#06b6d4'], '1536x1024', false],
    ['把主体放到海边日落场景中，柔和逆光，写实摄影风格', '图像融合', ['#ff8a4c', '#c2410c'], '1024x1024', false],
    ['大理石台面，柔和顶光，极简高级感', '商品图生成', ['#d1d5db', '#9ca3af'], '1024x1536', true],
    ['日系胶片质感，浅景深，窗边自然光', '人物写真', ['#fbbf24', '#7c3aed'], '1024x1024', false],
    ['水墨风格的远山与孤舟，留白意境', '自由生成', ['#64748b', '#0f172a'], '1024x1024', false],
  ];
  const cv = document.createElement('canvas');
  cv.width = 560; cv.height = 560;
  const ctx = cv.getContext('2d');
  await ImgStore.clear();
  for (const [prompt, toolName, colors, size, fav] of samples) {
    const g = ctx.createLinearGradient(0, 0, 560, 560);
    g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 560, 560);
    ctx.globalAlpha = 0.2; ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 6; k++) {
      ctx.beginPath();
      ctx.arc(80 + k * 80, 150 + (k % 3) * 130, 30 + (k % 4) * 16, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    await ImgStore.save(cv.toDataURL('image/jpeg', 0.9), {
      prompt, tool: 'x', toolName, size, model: 'gpt-image-2',
      usedRef: toolName !== '自由生成', favorite: fav,
    });
  }
  return await ImgStore.count();
})()`;

/* ---------------------------------------------------------------- 主流程 */
(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('='.repeat(70));
  console.log(`界面截图   目标=${BASE}   输出=${OUT}`);
  console.log('='.repeat(70));

  const { child, profile, wsUrl } = await launch();
  const cdp = new CDP(await connect(wsUrl));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  try {
    // ---- 生成页（空态） ----
    await cdp.goto(`${BASE}/image`);
    await cdp.waitFor(`!!document.getElementById('toolNav').children.length`,
      20000, '侧栏工具列表渲染');
    await cdp.shot('ui_1_generate.png');

    // ---- 作品库（先播种本机 IndexedDB，再点侧栏入口） ----
    const n = await cdp.evaluate(SEED);
    console.log(`  已向浏览器本机 IndexedDB 播种 ${n} 张示例图`);
    await cdp.evaluate(`document.querySelector('[data-view=projects]').click(), 1`);
    await cdp.waitFor(`document.querySelectorAll('#projGrid .pcard').length > 0`,
      20000, '作品库网格渲染');
    await sleep(500);
    await cdp.shot('ui_2_projects.png');

    // ---- 灯箱 ----
    await cdp.evaluate(`document.querySelector('#projGrid .pcard-img').click(), 1`);
    await cdp.waitFor(`!document.getElementById('lightbox').hidden`, 10000, '灯箱打开');
    await sleep(400);
    await cdp.shot('ui_3_lightbox.png');
    await cdp.evaluate(`document.getElementById('lbClose').click(), 1`);

    // ---- 结果态：把一张示例图塞进结果区，验证结果布局 ----
    await cdp.evaluate(`(async () => {
      const rows = await ImgStore.list();
      const rec = await ImgStore.get(rows[0].id);
      const url = ImgStore.bufferToURL(rec.full, rec.mime);
      document.querySelector('[data-tool=create]').click();
      const btn = document.getElementById('btnGenerate');
      // 直接构造结果视图，不消耗额度
      const im = new Image();
      await new Promise(r => { im.onload = r; im.src = url; });
      window.__shotResult = () => {
        document.getElementById('stateEmpty').hidden = true;
        document.getElementById('stateLoading').hidden = true;
        document.getElementById('stateError').hidden = true;
        const res = document.getElementById('result');
        res.hidden = false;
        document.getElementById('resultImg').src = url;
        document.getElementById('resSize').textContent = '尺寸 1024x1024';
        document.getElementById('resModel').textContent = 'gpt-image-2';
        document.getElementById('resElapsed').textContent = '耗时 48.6s';
        document.getElementById('resSaved').hidden = false;
        document.getElementById('resSaved').textContent = '已存入作品库（1 张）';
        document.getElementById('resPrompt').textContent = rows[0].prompt;
        return true;
      };
      return true;
    })()`);
    await cdp.evaluate(`window.__shotResult()`);
    await sleep(600);
    await cdp.shot('ui_4_result.png');

    // ---- 加载态 ----
    await cdp.evaluate(`(() => {
      document.getElementById('result').hidden = true;
      document.getElementById('stateLoading').hidden = false;
      document.getElementById('elapsed').textContent = '23.4';
      document.getElementById('loadingSub').textContent = '模型 gpt-image-2 · 1024x1024 · 2 张';
      document.getElementById('skGrid').innerHTML = '<div class="sk"></div><div class="sk"></div>';
      return true;
    })()`);
    await sleep(400);
    await cdp.shot('ui_5_loading.png');

    // ---- 错误态 ----
    await cdp.evaluate(`(() => {
      document.getElementById('stateLoading').hidden = true;
      document.getElementById('stateError').hidden = false;
      document.getElementById('errTitle').textContent = '生成失败';
      document.getElementById('errMsg').textContent = '请求过于频繁或额度不足，稍后再试或检查账户余额';
      const h = document.getElementById('errHint');
      h.hidden = false; h.textContent = '中转站返回 HTTP 429';
      return true;
    })()`);
    await sleep(400);
    await cdp.shot('ui_6_error.png');

    // ---- 后台管理 ----
    await cdp.goto(`${BASE}/admin`);
    await cdp.waitFor(`!document.getElementById('gateCard') || true`, 5000);
    await sleep(600);
    await cdp.shot('ui_7_admin_login.png');

    if (PASSWORD) {
      const res = await cdp.evaluate(`(async () => {
        const r = await fetch('/api/admin/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }),
        });
        return r.status;
      })()`);
      if (res === 200) {
        await cdp.goto(`${BASE}/admin`);
        await cdp.waitFor(`!document.getElementById('shell').hidden`, 20000, '后台主界面');
        await sleep(700);
        await cdp.shot('ui_8_admin_overview.png');
        await cdp.evaluate(`document.querySelector('[data-page=providers]').click(), 1`);
        await sleep(500);
        await cdp.shot('ui_9_admin_providers.png');
        await cdp.evaluate(`document.querySelector('[data-page=security]').click(), 1`);
        await sleep(400);
        await cdp.shot('ui_10_admin_security.png');
      } else {
        console.log(`  ! 后台登录失败（HTTP ${res}），跳过登录后的截图`);
      }
    } else {
      console.log('  · 未提供 --password，跳过后台登录后的截图');
    }

    console.log('\n截图完成。');
  } finally {
    child.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }
})().catch((e) => {
  console.error('截图失败：' + e.message);
  process.exitCode = 1;
});
