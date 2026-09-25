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
const VERIFY = process.argv.includes('--verify');
const VERIFY_PASS = [];
const VERIFY_FAIL = [];

const check = (name, ok, detail = '') => {
  (ok ? VERIFY_PASS : VERIFY_FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

const sleep2 = (ms) => new Promise(r => setTimeout(r, ms));

async function clickAt(cdp, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep2(320);
}

/** 按选择器找到元素中心点并派发真实鼠标事件（比 element.click() 更接近用户操作） */
async function click(cdp, sel) {
  // 用字符串拼接而不是嵌套模板串，避免转义踩坑
  const expr = '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');'
    + ' if (!el) return null; const r = el.getBoundingClientRect();'
    + ' return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()';
  const pt = await cdp.evaluate(expr);
  if (!pt) { check(`点击 ${sel}`, false, '元素不存在'); return null; }
  await clickAt(cdp, pt.x, pt.y);
  return pt;
}

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
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.events.push('EXCEPTION: ' +
          (msg.params.exceptionDetails.exception?.description ||
           msg.params.exceptionDetails.text || '').split('\n')[0]);
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
    // ---- 无痕改字页（同一外壳） ----
    await cdp.goto(`${BASE}/`);
    await cdp.waitFor(`!!document.getElementById('appSidebar').children.length`,
      20000, '侧栏渲染');
    await sleep(600);
    await cdp.shot('ui_0_edit.png');

    // ---- 生成页（空态） ----
    await cdp.goto(`${BASE}/image`);
    await cdp.waitFor(`!!document.getElementById('appSidebar').children.length`,
      20000, '侧栏工具列表渲染');
    await cdp.shot('ui_1_generate.png');

    // ---- 作品库（先播种本机 IndexedDB，再点侧栏入口） ----
    const n = await cdp.evaluate(SEED);
    console.log(`  已向浏览器本机 IndexedDB 播种 ${n} 张示例图`);
    await cdp.evaluate(`location.hash = '#projects', 1`);
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
    await cdp.evaluate(`location.hash = '#create', 1`);
    await sleep(600);
    await cdp.evaluate(`(async () => {
      const rows = await ImgStore.list();
      const rec = await ImgStore.get(rows[0].id);
      const url = ImgStore.bufferToURL(rec.full, rec.mime);
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

    // ---- 交互回归：这两个坑都真的踩过，固化成断言 ----
    if (VERIFY) {
      console.log('\n[交互回归]');
      await cdp.goto(`${BASE}/image`);
      await cdp.waitFor(`!!document.getElementById('btnCollapse')`, 20000, '侧栏');
      const collapsed = async () => cdp.evaluate(`(() => {
        const q = s => document.querySelector(s);
        const col = q('#btnCollapse'); const r = col && col.getBoundingClientRect();
        const hit = r ? document.elementFromPoint(Math.round(r.x + r.width/2), Math.round(r.y + r.height/2)) : null;
        const pop = q('#popWrap .pop');
        let popVisible = false;
        if (pop) { const pr = pop.getBoundingClientRect();
          popVisible = pr.width > 0 && pr.height > 0 && getComputedStyle(pop).display !== 'none'; }
        return {
          collapsed: q('.app').classList.contains('collapsed'),
          sidebarW: Math.round(q('.sidebar').getBoundingClientRect().width),
          toggleW: r ? Math.round(r.width) : 0,
          toggleClickable: !!col && !!hit && (col === hit || col.contains(hit)),
          popInDom: document.querySelectorAll('#popWrap .pop').length,
          popVisible,
        };
      })()`);

      await cdp.evaluate(`localStorage.removeItem('wb.sbCollapsed'), 1`);
      await cdp.goto(`${BASE}/image`);
      await sleep(900);

      await click(cdp, '#btnCollapse');
      const c1 = await collapsed();
      check('侧栏可折叠', c1.collapsed && c1.sidebarW < 100, `宽 ${c1.sidebarW}`);
      check('折叠后按钮仍有尺寸且可点', c1.toggleW > 10 && c1.toggleClickable,
        `${c1.toggleW}px clickable=${c1.toggleClickable}`);

      await click(cdp, '#btnCollapse');
      const c2 = await collapsed();
      check('折叠后可再展开', !c2.collapsed && c2.sidebarW > 200, `宽 ${c2.sidebarW}`);

      await click(cdp, '#pillSize');
      const p1 = await collapsed();
      check('尺寸菜单可打开', p1.popVisible && p1.popInDom === 1);
      const opt = await cdp.evaluate(`(() => { const b = document.querySelector('#popWrap .pop button');
        if (!b) return null; const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
      if (opt) await clickAt(cdp, opt.x, opt.y);
      const p2 = await collapsed();
      check('选中后菜单彻底移除（不留残影）',
        p2.popInDom === 0 && !p2.popVisible,
        `dom=${p2.popInDom} visible=${p2.popVisible}`);

      await click(cdp, '#pillSize');
      await clickAt(cdp, 760, 300);
      const p3 = await collapsed();
      check('点空白处可关闭且无残影', p3.popInDom === 0 && !p3.popVisible);

      const errs = cdp.events.filter(e => typeof e === 'string' && e.startsWith('EXCEPTION'));
      check('无页面 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | '));

      // 文字处理页也接进了同一外壳
      await cdp.goto(`${BASE}/`);
      await cdp.waitFor(`!!document.getElementById('appSidebar').children.length`,
        20000, '改字页侧栏');
      await sleep(500);
      const edit = await cdp.evaluate(`(() => {
        const q = (s) => document.querySelector(s);
        const vis = (el) => !!el && el.getBoundingClientRect().height > 0;
        const on = q('#appSidebar .sb-item.on');
        return {
          hasNav: !!q('#appSidebar .sb-nav'),
          activeKey: on ? on.dataset.key : '',
          stage: vis(q('#stage')),
          inspector: vis(q('.inspector')),
          exportBtn: !!q('#btnExport'),
          statusbar: vis(q('.statusbar')),
        };
      })()`);
      check('改字页共用同一侧栏且高亮正确',
        edit.hasNav && edit.activeKey === 'edit', `active=${edit.activeKey}`);
      check('改字页画布 / 属性面板 / 状态栏在位',
        edit.stage && edit.inspector && edit.exportBtn && edit.statusbar);

      const errs2 = cdp.events.filter(e => typeof e === 'string' && e.startsWith('EXCEPTION'));
      check('两个页面全程无 JS 异常', errs2.length === 0, errs2.slice(0, 3).join(' | '));

      // 改字页走一遍真实流程：上传 → 识别 → 选中 → 编辑面板
      const card = path.resolve(arg('card', 'samples/test_card.png'));
      if (fs.existsSync(card)) {
        await cdp.send('DOM.enable');
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        const inp = await cdp.send('DOM.querySelector',
          { nodeId: doc.root.nodeId, selector: '#fileInput' });
        await cdp.send('DOM.setFileInputFiles', { files: [card], nodeId: inp.nodeId });
        try {
          await cdp.waitFor(`document.querySelectorAll('#itemList .item').length > 0`,
            90000, '识别结果列表');
          const f = await cdp.evaluate(`(() => {
            const q = (s) => document.querySelector(s);
            return {
              items: document.querySelectorAll('#itemList .item').length,
              badge: q('#countBadge').textContent,
              exportEnabled: !q('#btnExport').disabled,
              status: q('#statusText').textContent,
            };
          })()`);
          check('上传后可识别出文字', f.items > 0, `${f.items} 项 · ${f.status}`);
          check('导出按钮已可用', f.exportEnabled);

          await click(cdp, '#itemList .item');
          await sleep(400);
          const ed = await cdp.evaluate(`(() => {
            const q = (s) => document.querySelector(s);
            return {
              editorOpen: q('#editorCard') && q('#editorCard').getBoundingClientRect().height > 0,
              origText: q('#origText').textContent,
              inputText: q('#inpText').value,
            };
          })()`);
          check('点列表项后编辑面板打开并回填原文',
            ed.editorOpen && ed.origText !== '—' && ed.inputText === ed.origText,
            `原文="${ed.origText}"`);
          await cdp.shot('ui_11_edit_loaded.png');
        } catch (e) {
          check('改字页完整流程', false, e.message);
        }
      } else {
        console.log(`  · 找不到 ${card}，跳过改字页流程测试`);
      }

      console.log(`\n交互回归：通过 ${VERIFY_PASS.length} 项，失败 ${VERIFY_FAIL.length} 项`);
      if (VERIFY_FAIL.length) {
        console.log('失败项：' + VERIFY_FAIL.join('、'));
        process.exitCode = 1;
      }
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
