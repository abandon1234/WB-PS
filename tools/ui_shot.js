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

/** 设值并派发 input 事件，触发页面自己的编辑逻辑 */
async function setInput(cdp, sel, value) {
  const expr = '(() => { const el = document.querySelector(' + JSON.stringify(sel) + ');'
    + ' if (!el) return null; el.value = ' + JSON.stringify(value) + ';'
    + " el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()";
  return cdp.evaluate(expr);
}

/** 往 <input type=file> 里塞真实文件（走 DOM.setFileInputFiles） */
async function setFile(cdp, sel, filePath) {
  await cdp.send('DOM.enable');
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
  if (!node || !node.nodeId) throw new Error('找不到文件输入框：' + sel);
  await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
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
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        // 页面里的 confirm() 会在无头模式下把流程挂住，统一自动确认
        this.events.push('DIALOG: ' + (msg.params.message || '').split('\n')[0]);
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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

          // ---- 切页续做：这是用户报的核心问题 ----
          await setInput(cdp, '#inpText', '切页续做测试');
          await sleep(1800);                      // 等防抖预览 + 落盘
          const before = await cdp.evaluate(`(() => ({
            changed: document.querySelectorAll('#itemList .item.changed').length,
            foot: document.getElementById('footLeft').textContent,
          }))()`);
          check('切页前已产生改动', before.changed >= 1, `${before.changed} 项 · ${before.foot}`);

          await cdp.goto(`${BASE}/image`);        // 去生成页
          await cdp.waitFor(`!!document.getElementById('appSidebar')`, 20000, '生成页');
          await sleep(600);
          await cdp.goto(`${BASE}/`);             // 再切回来
          try {
            await cdp.waitFor(`document.querySelectorAll('#itemList .item').length > 0`,
              45000, '切回后自动恢复');
            await sleep(1200);                    // 等改动样式回填
            const after = await cdp.evaluate(`(() => {
              const q = (s) => document.querySelector(s);
              return {
                items: document.querySelectorAll('#itemList .item').length,
                changed: document.querySelectorAll('#itemList .item.changed').length,
                status: q('#statusText').textContent,
                foot: q('#footLeft').textContent,
                visible: !q('#viewport').hidden,
                closeShown: !q('#btnClose').hidden,
              };
            })()`);
            check('切回后原图与文字框仍在',
              after.visible && after.items === f.items, `${after.items} 项（切页前 ${f.items}）`);
            check('切回后改动未丢失',
              after.changed >= 1 && after.changed === before.changed,
              `${after.changed} 项 · ${after.status}`);
            check('切回后可继续编辑（关闭按钮已出现）', after.closeShown);
            await cdp.shot('ui_12_restored.png');
          } catch (e) {
            check('切回后自动恢复工作区', false, e.message);
          }

          // ---- 关闭图片应清掉本机快照 ----
          await click(cdp, '#btnClose');
          await sleep(900);
          const closed = await cdp.evaluate(`(() => {
            const q = (s) => document.querySelector(s);
            return {
              items: document.querySelectorAll('#itemList .item').length,
              emptyShown: !q('#emptyState').hidden,
              closeHidden: q('#btnClose').hidden,
            };
          })()`);
          check('关闭图片后回到空状态',
            closed.emptyShown && closed.items === 0 && closed.closeHidden,
            `${closed.items} 项`);

          await cdp.goto(`${BASE}/`);
          await sleep(1400);
          const afterClose = await cdp.evaluate(
            `document.querySelectorAll('#itemList .item').length`);
          check('关闭后刷新不再自动恢复', afterClose === 0, `${afterClose} 项`);
        } catch (e) {
          check('改字页完整流程', false, e.message);
        }
      } else {
        console.log(`  · 找不到 ${card}，跳过改字页流程测试`);
      }

      // ---- 四个工具必须是真的不一样：拦下请求看 payload，不消耗额度 ----
      console.log('\n[工具差异化]');
      await cdp.goto(`${BASE}/image`);
      await cdp.waitFor(`!!document.getElementById('btnGenerate')`, 20000, '生成页');
      await sleep(600);

      // 把 /api/image/generate 换成假的成功响应：既能跑完整渲染链路，又不花额度
      await cdp.evaluate(`(() => {
        window.__cap = null;
        window.__origFetch = window.fetch;
        window.fetch = function (url, opt) {
          if (String(url).indexOf('/api/image/generate') >= 0) {
            const fd = opt && opt.body;
            window.__cap = {
              prompt: fd && fd.get ? fd.get('prompt') : null,
              tool: fd && fd.get ? fd.get('tool') : null,
              size: fd && fd.get ? fd.get('size') : null,
              refs: fd && fd.getAll ? fd.getAll('references').length : 0,
            };
            const cv = document.createElement('canvas');
            cv.width = 320; cv.height = 320;
            const ct = cv.getContext('2d');
            const g = ct.createLinearGradient(0, 0, 320, 320);
            g.addColorStop(0, '#7ee04a'); g.addColorStop(1, '#2f8f5b');
            ct.fillStyle = g; ct.fillRect(0, 0, 320, 320);
            const names = { create: '自由生成', combine: '图像融合',
                            portrait: '人物写真', product: '商品图生成' };
            const payload = {
              ok: true,
              images: [{ data_url: cv.toDataURL('image/png'), url: '', bytes: 1234,
                         revised_prompt: '' }],
              elapsed: 1.2, used_reference: window.__cap.refs > 0,
              reference_count: window.__cap.refs,
              model: 'gpt-image-2', size: window.__cap.size, count: 1,
              tool: window.__cap.tool, tool_name: names[window.__cap.tool] || '',
              provider: { name: 'stub', model: 'gpt-image-2' },
            };
            return Promise.resolve(new Response(JSON.stringify(payload),
              { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return window.__origFetch.apply(this, arguments);
        };
        return true;
      })()`);

      const toolState = () => cdp.evaluate(`(() => {
        const q = (s) => document.querySelector(s);
        return {
          resultHidden: q('#result').hidden,
          emptyVisible: !q('#stateEmpty').hidden,
          dzVisible: !q('#dropzone').hidden,
          noteVisible: !q('#refNote').hidden,
          noteText: q('#refNoteText').textContent,
          sizeText: q('#pillSizeText').textContent,
          refCount: q('#refCount').textContent,
          emptyTitle: q('#emptyTitle').textContent,
        };
      })()`);

      async function runTool(key, needRef) {
        await cdp.evaluate(`location.hash = '#${key}', 1`);
        await sleep(450);
        await cdp.shot(`ui_14_tool_${key}.png`);        // 切过去、还没上传参照图的样子
        if (needRef) { await setFile(cdp, '#refInput', card); await sleep(600); }
        await setInput(cdp, '#prompt', '统一的测试提示词');
        await click(cdp, '#btnGenerate');
        await sleep(1300);
        return cdp.evaluate(`(() => {
          const q = (s) => document.querySelector(s);
          return {
            cap: window.__cap,
            tool: q('#resTool').textContent,
            sentShown: !q('#resSentWrap').hidden,
            sent: q('#resSent').textContent,
            resultVisible: !q('#result').hidden,
            saved: q('#resSaved').textContent,
          };
        })()`);
      }

      // 自由生成：不需要参照图、原样发送
      await cdp.evaluate(`location.hash = '#create', 1`);
      await sleep(600);
      const stCreate = await toolState();
      check('自由生成：隐藏上传区并说明原因',
        !stCreate.dzVisible && stCreate.noteVisible, stCreate.noteText.slice(0, 24) + '…');
      check('自由生成：参照图计数显示「无需」', stCreate.refCount === '无需', stCreate.refCount);
      check('自由生成：默认尺寸 1024×1024', stCreate.sizeText === '1024×1024', stCreate.sizeText);

      const rCreate = await runTool('create', false);
      check('自由生成：提示词原样发送（不加工具指令）',
        rCreate.cap.prompt === '统一的测试提示词', JSON.stringify(rCreate.cap.prompt));
      check('自由生成：不带参照图', rCreate.cap.refs === 0, `${rCreate.cap.refs} 张`);
      check('自由生成：结果不显示「实际发送的提示词」', !rCreate.sentShown);
      check('自由生成：结果标签正确', rCreate.tool === '自由生成', rCreate.tool);

      // 切到图像融合：上一张结果必须被清掉
      await cdp.evaluate(`location.hash = '#combine', 1`);
      await sleep(600);
      const stCombine = await toolState();
      check('切工具后上一张结果被清空（不会误以为四个工具一样）',
        stCombine.resultHidden && stCombine.emptyVisible);
      check('图像融合：显示上传区', stCombine.dzVisible && !stCombine.noteVisible);
      check('图像融合：默认尺寸走「自动」', stCombine.sizeText === '自动', stCombine.sizeText);
      check('图像融合：缺参照图时先提示上传',
        stCombine.emptyTitle.indexOf('参照图') >= 0, stCombine.emptyTitle);

      const rCombine = await runTool('combine', true);
      check('图像融合：提示词被加上融合指令',
        rCombine.cap.prompt.indexOf('把参照图中的主体自然地融入') >= 0
        && rCombine.cap.prompt.indexOf('统一的测试提示词') >= 0,
        rCombine.cap.prompt.split('\n')[0]);
      check('图像融合：结果区展示实际发送的提示词',
        rCombine.sentShown && rCombine.sent.indexOf('统一') >= 0);

      const rPortrait = await runTool('portrait', true);
      check('人物写真：提示词被加上身份保持指令',
        rPortrait.cap.prompt.indexOf('以参照图中人物的五官') >= 0,
        rPortrait.cap.prompt.split('\n')[0]);
      check('人物写真：默认竖版 1024×1536',
        rPortrait.cap.size === '1024x1536', rPortrait.cap.size);
      check('人物写真：结果标签正确', rPortrait.tool === '人物写真', rPortrait.tool);

      const rProduct = await runTool('product', true);
      check('商品图生成：提示词被加上电商主图指令',
        rProduct.cap.prompt.indexOf('电商商品图') >= 0,
        rProduct.cap.prompt.split('\n')[0]);
      check('商品图生成：默认尺寸 1024×1024', rProduct.cap.size === '1024x1024', rProduct.cap.size);

      const all4 = [rCreate.cap.tool, rCombine.cap.tool, rPortrait.cap.tool, rProduct.cap.tool];
      check('四个工具下发的 tool 标识互不相同', new Set(all4).size === 4, all4.join('/'));
      const prompts4 = [rCreate.cap.prompt, rCombine.cap.prompt,
                        rPortrait.cap.prompt, rProduct.cap.prompt];
      check('四个工具实际发出的提示词互不相同', new Set(prompts4).size === 4);

      // ---- 骨架屏的渐变动画 ----
      await cdp.evaluate(`(() => {
        const q = (s) => document.querySelector(s);
        q('#result').hidden = true;
        q('#stateEmpty').hidden = true;
        q('#stateError').hidden = true;
        q('#stateLoading').hidden = false;
        q('#skGrid').innerHTML =
          '<div class="sk" style="width:172px;height:172px"></div>'
          + '<div class="sk" style="width:172px;height:172px"></div>';
        q('#elapsed').textContent = '18.6';
        return true;
      })()`);
      await sleep(400);
      const skInfo = await cdp.evaluate(`(() => {
        const el = document.querySelector('#skGrid .sk');
        const cs = getComputedStyle(el);
        const bf = getComputedStyle(el, '::before');
        return {
          anim: cs.animationName, dur: cs.animationDuration,
          grad: cs.backgroundImage.indexOf('linear-gradient') >= 0,
          conic: bf.backgroundImage.indexOf('conic-gradient') >= 0,
          anim2: bf.animationName,
        };
      })()`);
      check('骨架屏：渐变扫光动画已生效',
        skInfo.anim === 'skSweep' && skInfo.grad, `${skInfo.anim} ${skInfo.dur}`);
      check('骨架屏：旋转柔光层已生效',
        skInfo.conic && skInfo.anim2 === 'skSpin', skInfo.anim2);
      await cdp.shot('ui_13_loading_gradient.png');

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
