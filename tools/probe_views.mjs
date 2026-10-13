/**
 * 三视图（无痕改字 / 文字工坊 / 图像生成）切换验证
 *
 * 关注五件事：
 *   1. / 上各视图能按 hash 正确切换（改字 ↔ 文字工坊 ↔ 生成 ↔ 作品库）
 *   2. 切换【不再重新加载页面】（这是当初合并的目的）
 *   3. 老链接 /image 与老 hash（#create/#combine…）仍能落到生成视图
 *   4. 文字工坊的三种模式深链（#text / #text-copy / #text-mask / #text-translate）
 *   5. 切换耗时（与合并前对比）
 *
 *   node tools/probe_views.mjs [--base http://127.0.0.1:8788] [--profile <dir>]
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
const BASE = arg('base', 'http://127.0.0.1:8788').replace(/\/$/, '');
const fixedProfile = arg('profile', '');
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASS = [], FAIL = [];
const check = (name, ok, detail = '') => {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

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
  async waitFor(expr, timeout = 120000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) {}
      await sleep(200);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-views-${Date.now()}`);
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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

// 统计页面加载次数：合并成功后，切视图不该再触发新的 document 加载
let docLoads = 0;
cdp.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) docLoads++; });
const pageErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(String(
  p.exceptionDetails?.exception?.description || p.exceptionDetails?.text).split('\n')[0]));

// 自动放行 confirm()：无头下没人点"确定"，对话框会把脚本挂住
// （改字视图的"覆盖当前图片"确认、关闭图片的确认都会走这里）。
cdp.on('Page.javascriptDialogOpening', () => {
  cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});

const viewState = () => cdp.evaluate(`(() => {
  const vis = (el) => !!(el && !el.hidden && getComputedStyle(el).display !== 'none');
  const e = document.getElementById('viewEdit');
  const i = document.getElementById('viewImages');
  const t = document.getElementById('viewText');
  return {
    edit: vis(e), images: vis(i), text: vis(t),
    hash: location.hash, path: location.pathname,
    genVisible: vis(document.getElementById('viewGenerate')),
    projVisible: vis(document.getElementById('viewProjects')),
    copyVisible: vis(document.getElementById('viewTextCopy')),
    maskVisible: vis(document.getElementById('viewTextMask')),
    transVisible: vis(document.getElementById('viewTextTranslate')),
    bodyMode: document.body.className,
  };
})()`);

/** 每个视图对应的容器 id（clickNav 用它判断"切过去了没有"） */
const VIEW_ID = { edit: 'viewEdit', images: 'viewImages', text: 'viewText' };

/** 点侧边栏导航项，并等目标视图真正显示出来（不是死等固定时长） */
async function clickNav(key, expect) {
  const t0 = Date.now();
  // 侧边栏由 shell.js 异步渲染，点击前先确认目标项存在 ——
  // 否则 querySelector 拿不到元素、点击静默失败（表现成"点了没反应"）。
  await cdp.waitFor(`!!document.querySelector('.sb-item[data-key="${key}"]')`,
    20000, `侧边栏出现 ${key} 项`);
  const ok = await cdp.evaluate(`(() => {
    const a = document.querySelector('.sb-item[data-key="${key}"]');
    if (!a) return false;
    a.click();
    return true;
  })()`);
  // 等到期望的视图可见 —— 切换本身很快，但内部还要渲染，固定 sleep 会误判
  const vid = VIEW_ID[expect] || 'viewEdit';
  const expr = `(() => { const el = document.getElementById('${vid}');`
    + " return !!(el && !el.hidden && getComputedStyle(el).display !== 'none'); })()";
  try {
    await cdp.waitFor(expr, 15000, `切到 ${expect}`);
  } catch (_) { /* 交给断言报错 */ }
  return { ok, ms: Date.now() - t0 };
}

try {
  console.log('='.repeat(74));
  console.log(`三视图切换验证   ${BASE}/`);
  console.log('='.repeat(74));

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor("!!window.WBImage", 120000, '生成模块加载');
  await cdp.waitFor("!!window.WBImage.ready", 60000, '生成模块就绪');
  // 等视图路由把改字视图显示出来（外层路由是异步接管的）
  await cdp.waitFor(
    "(() => { const e = document.getElementById('viewEdit');"
    + " const i = document.getElementById('viewImages');"
    + " if (!e || !i) return false;"
    + " return !e.hidden && i.hidden; })()",
    30000, '初始落在改字视图');
  console.log('\n[1] 初始状态');
  const s0 = await viewState();
  check('默认落在改字视图', s0.edit === true && s0.images === false,
    `hash="${s0.hash}" body=${s0.bodyMode}`);
  const loadsAfterFirst = docLoads;

  console.log('\n[2] 点侧边栏「AI 生成」');
  const dbg = await cdp.evaluate(`(() => {
    const a = document.querySelector('.sb-item[data-key="generate"]');
    return { found: !!a, tag: a ? a.tagName : '', href: a ? a.getAttribute('href') : '',
             hash: location.hash };
  })()`);
  console.log(`      侧边栏项：found=${dbg.found} ${dbg.tag} href=${dbg.href} hash="${dbg.hash}"`);
  const c1 = await clickNav('generate', 'images');
  const s1 = await viewState();
  check('点击导航项成功', c1.ok === true, `ok=${c1.ok}`);
  check('切到生成视图', s1.images === true && s1.edit === false,
    `${c1.ms}ms · hash="${s1.hash}"`);
  check('生成视图内部显示生成区', s1.genVisible === true);
  check('切换没有重新加载页面', docLoads === loadsAfterFirst,
    `文档加载次数 ${docLoads}（切换前 ${loadsAfterFirst}）`);

  console.log('\n[2b] 合并后的侧栏与文案');
  const copy = await cdp.evaluate(`(() => {
    const q = (s) => (document.querySelector(s)?.textContent || '').trim();
    return {
      navs: [...document.querySelectorAll('.sb-item')].map(a => a.dataset.key),
      title: q('#toolTitle'),
      hint: q('#dropzone .dz-inner span'),
      refCount: q('#refCount'),
      tips: [...document.querySelectorAll('#emptyHints li')].map(li => li.textContent.trim()),
    };
  })()`);
  console.log(`      侧栏项：${copy.navs.join(' / ')}`);
  check('侧栏四项（改字 / 文字工坊 / AI 生成 / 作品库）',
    copy.navs.join(',') === 'edit,text,generate,projects', copy.navs.join(','));
  check('生成区标题是「AI 图片生成」', copy.title === 'AI 图片生成', copy.title);
  check('上传区说明写明「不传就是纯文生图」',
    copy.hint.includes('不传就是纯文生图'), copy.hint);
  check('参照图不再强制（计数为 0/4）', copy.refCount === '0/4', copy.refCount);
  check('空态提示已按合并后的语义改写',
    copy.tips.length === 3 && copy.tips[0].includes('不传参考图'), copy.tips[0] || '');

  console.log('\n[2c] 文字工坊：模式切换');
  const ctw = await clickNav('text', 'text');
  const stw = await viewState();
  check('点侧栏切到文字工坊视图',
    stw.text === true && stw.edit === false && stw.images === false,
    `${ctw.ms}ms · hash="${stw.hash}"`);
  check('默认落在「取文字」模式',
    stw.copyVisible === true && stw.maskVisible === false && stw.transVisible === false,
    `hash="${stw.hash}"`);
  check('文字工坊切换没有重新加载页面', docLoads === loadsAfterFirst,
    `文档加载 ${docLoads} 次`);

  // 点页签切模式：hash 要跟着变，否则这个地址分享出去就回不到同一个模式
  const tabOk = await cdp.evaluate(`(() => {
    const b = document.querySelector('.tw-tab[data-mode="mask"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(400);
  const sm = await viewState();
  check('点「打码」页签切到打码模式',
    tabOk && sm.maskVisible === true && sm.copyVisible === false, `hash="${sm.hash}"`);
  check('切模式后 hash 同步为 #text-mask', sm.hash === '#text-mask', `hash="${sm.hash}"`);

  console.log('\n[2d] 取文字：纯函数层（不依赖 OCR，用构造的框）');
  const pure = await cdp.evaluate(`(async () => {
    const m = await import('/static/engine/extract.js');
    const items = [
      { id: 0, rect: { x: 100, y: 200, w: 80, h: 20 }, text: '第二行', score: .9, angle: 0, quad_axis: true },
      { id: 1, rect: { x: 20, y: 100, w: 160, h: 60 }, text: '大标题', score: .9, angle: 0, quad_axis: true },
      { id: 2, rect: { x: 20, y: 200, w: 60, h: 20 }, text: '第一行', score: .9, angle: 0, quad_axis: true },
      { id: 3, rect: { x: 20, y: 240, w: 300, h: 20 }, text: '正文一句结束了。', score: .9, angle: 0, quad_axis: true },
      { id: 4, rect: { x: 20, y: 280, w: 300, h: 20 }, text: '另一段话', score: .9, angle: 0, quad_axis: true },
    ];
    const out = m.extract(items);
    return {
      lines: out.lines.map(l => l.text),
      paras: out.paragraphs.map(p => p.map(l => l.text)),
      md: out.markdown,
      tight: m.joinSegments(['SN-2026', '0918'],
        { gaps: [0, 0.5], lineH: 20 }),
      loose: m.joinSegments(['Hello', 'world']),
    };
  })()`);
  console.log(`      行：${JSON.stringify(pure.lines)}`);
  console.log(`      段：${JSON.stringify(pure.paras)}`);
  check('纯函数：行内按 x 排、跨行按 y 排',
    pure.lines.join('|') === '大标题|第一行第二行|正文一句结束了。|另一段话',
    pure.lines.join('|'));
  check('纯函数：句末标点断开分段、标题不并进正文',
    pure.paras.length === 3 && pure.paras[0].length === 1 && pure.paras[0][0] === '大标题',
    JSON.stringify(pure.paras));
  check('纯函数：md 按行高给出标题层级',
    pure.md.startsWith('## 大标题'), JSON.stringify(pure.md.split('\n')[0]));
  check('纯函数：段落内合行、中文不加空格（ASCII 词之间才加）',
    pure.md.includes('第一行第二行正文一句结束了。'), '');
  check('纯函数：贴得很近的片段不插空格', pure.tight === 'SN-20260918', pure.tight);
  check('纯函数：正常间距的英文词之间加空格', pure.loose === 'Hello world', pure.loose);

  console.log('\n[2e] 取文字：喂样例图跑通识别 → 列表 → 导出');
  // [2c] 结束在「打码」页签，先切回「取文字」—— 面板隐藏时量出来是 0×0，
  // 下面的检测框对齐与缩放断言都要真实布局。
  await cdp.evaluate("(() => { const b = document.querySelector('.tw-tab[data-mode=\"copy\"]');"
    + ' if (b) b.click(); return true; })()');
  await cdp.waitFor("(() => { const e = document.getElementById('viewTextCopy');"
    + " return !!(e && !e.hidden && e.getBoundingClientRect().width > 100); })()",
    10000, '切回取文字模式');
  await sleep(300);

  await cdp.send('DOM.enable');
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#copyInput' });
  check('取文字：上传入口存在', !!found && !!found.nodeId, `nodeId=${found && found.nodeId}`);
  const sample = path.resolve('samples/test_card.png');
  check('取文字：样例图存在', fs.existsSync(sample), sample);

  const t0det = Date.now();
  await cdp.send('DOM.setFileInputFiles', { files: [sample], nodeId: found.nodeId });
  await cdp.waitFor('!!(window.WBText && window.WBText.copy.result) || '
    + '!!(window.WBLocal && window.WBLocal.error)', 240000, '取样识别完成');
  const detMs = Date.now() - t0det;

  const tp = await cdp.evaluate(`(() => {
    const W = window.WBText, r = W.copy.result;
    const norm = (el) => (el ? el.textContent.trim() : '');
    return {
      ok: !!r,
      err: (window.WBLocal && window.WBLocal.error) ? String(window.WBLocal.error.message || '') : '',
      count: r ? r.count : 0,
      para: r ? r.paraCount : 0,
      lines: W.lines(),
      text: W.text(),
      md: W.markdown(),
      domRows: document.querySelectorAll('#copyLines .tw-line').length,
      boxes: document.querySelectorAll('#copyOverlay .tw-box').length,
      stats: norm(document.getElementById('copyStats')),
      meta: norm(document.getElementById('copyMeta')),
      foot: norm(document.querySelector('.tw-side-foot')),
      txtOn: !document.getElementById('copyTxtBtn').disabled,
      mdOn: !document.getElementById('copyMdBtn').disabled,
      status: norm(document.getElementById('copyStatusText')),
    };
  })()`);
  tp.lines.forEach((l, i) => console.log(`        ${i + 1}. ${l}`));
  console.log(`      ${tp.stats} · ${tp.meta} · 用时 ${detMs}ms`);

  check('取文字：识别成功（本地引擎无错）', tp.ok === true && !tp.err, tp.err);
  check('取文字：识别出行', tp.count > 0, `${tp.count} 行`);
  check('取文字：右侧列表行数与识别行数一致', tp.domRows === tp.count,
    `DOM ${tp.domRows} / 数据 ${tp.count}`);
  check('取文字：左侧检测框数与行数一致', tp.boxes === tp.count, `框 ${tp.boxes}`);
  check('取文字：第一行是页面大标题',
    (tp.lines[0] || '').includes('产品使用说明书'), tp.lines[0] || '(空)');
  check('取文字：联系方式那一行被完整取到（含中英混排）',
    tp.text.includes('support@example.com'), '');
  check('取文字：界面文本与导出文本一致',
    tp.lines.every((l) => tp.text.includes(l)), '');
  check('取文字：md 含标题层级',
    /^## /m.test(tp.md), JSON.stringify((tp.md.split('\n').find((l) => l.startsWith('## ')) || '').slice(0, 30)));
  check('取文字：导出按钮已启用', tp.txtOn === true && tp.mdOn === true);
  check('取文字：界面标注「本机 / 不上传」',
    /本机/.test(tp.foot) && /不上传/.test(tp.foot), tp.foot.slice(0, 40));
  check('取文字：识别耗时已回报到界面', /识别 \d+ms/.test(tp.meta), tp.meta);
  check('取文字：状态条收起（无残留「识别中」）', tp.status === '', tp.status);

  console.log('\n[2f] 取文字：长截图默认收进可视区（缩放）');
  // 复现用户报的问题：618×2560（1:4.14）的长截图按原宽铺开会有两千多 px 高，
  // 得滚半天才看得全。这里在页面里现造一张同比例的长图（把样例图纵向拼 5 份），
  // 走真实的 file input 路径，验「默认适应窗口 + 可放大 + 框不跑偏」。
  const readGeo = () => cdp.evaluate(`(() => {
    const c = document.getElementById('copyCanvas'), i = document.getElementById('copyImg');
    const cs = getComputedStyle(c);
    const availW = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = c.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const ir = i.getBoundingClientRect();
    const box = document.querySelector('#copyOverlay .tw-box');
    const br = box ? box.getBoundingClientRect() : null;
    return {
      nw: i.naturalWidth, nh: i.naturalHeight,
      w: +ir.width.toFixed(1), h: +ir.height.toFixed(1),
      availW: +availW.toFixed(1), availH: +availH.toFixed(1),
      zval: (document.getElementById('copyZoomVal') || {}).textContent || '',
      ctlShown: !document.getElementById('copyZoom').hidden,
      boxes: document.querySelectorAll('#copyOverlay .tw-box').length,
      // 首行检测框相对图的位置 —— 缩放前后必须一样（百分比定位的意义所在）
      boxRel: br ? { l: +((br.left - ir.left) / ir.width).toFixed(3),
                     t: +((br.top - ir.top) / ir.height).toFixed(3) } : null,
    };
  })()`);

  await cdp.evaluate(`(async () => {
    const cv = document.createElement('canvas');
    cv.width = 618; cv.height = 2560;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 618, 2560);
    const src = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej;
      im.src = '/samples/test_card.png';
    });
    const h = src.height * (618 / src.width);
    for (let k = 0; k < 5; k++) ctx.drawImage(src, 0, k * (h + 30), 618, h);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'tall_shot.png', { type: 'image/png' }));
    const inp = document.getElementById('copyInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await cdp.waitFor(`(() => { const i = document.getElementById('copyImg');
    const st = document.getElementById('copyStatus');
    return !!(i && i.naturalWidth === 618 && i.style.visibility !== 'hidden'
      && st && st.hidden && !(window.WBText.copy.busy)); })()`,
    90000, '长图已按适应窗口显示');
  // 状态条收起会改变画布可用高度，代码里会补算一次「适应」—— 等那一拍落地再量，
  // 否则量到的是"识别中、状态条还占着 44px"时的临时尺寸。
  await sleep(400);

  const fitted = await readGeo();
  console.log(`      原图 ${fitted.nw}×${fitted.nh} → 显示 ${fitted.w}×${fitted.h}`
    + `（可视区 ${fitted.availW}×${fitted.availH}）· 缩放 ${fitted.zval} · 框 ${fitted.boxes}`);
  check('长截图：显示尺寸没有超出可视区（不再按宽度铺开）',
    fitted.w <= fitted.availW + 1 && fitted.h <= fitted.availH + 1,
    `${fitted.w}×${fitted.h} vs ${fitted.availW}×${fitted.availH}`);
  check('长截图：长边方向接近铺满（没被缩得过小）',
    Math.max(fitted.w / fitted.availW, fitted.h / fitted.availH) > 0.9,
    `占比 ${(Math.max(fitted.w / fitted.availW, fitted.h / fitted.availH) * 100).toFixed(0)}%`);
  check('长截图：默认不是 100%', fitted.zval !== '100%' && fitted.zval !== '', fitted.zval);
  check('长截图：缩放控件已显示', fitted.ctlShown === true);

  await cdp.evaluate("document.getElementById('copyZoomIn').click()");
  await sleep(250);
  const zoomed = await readGeo();
  check('长截图：点 + 能明显放大（不是从 25% 挪到 25%）',
    zoomed.w > fitted.w * 1.1, `${fitted.w}×${fitted.h} → ${zoomed.w}×${zoomed.h} · ${zoomed.zval}`);
  check('长截图：放大后检测框仍贴原位（百分比定位不跑偏）',
    !fitted.boxRel || !zoomed.boxRel
      || (Math.abs(fitted.boxRel.l - zoomed.boxRel.l) < 0.01
          && Math.abs(fitted.boxRel.t - zoomed.boxRel.t) < 0.01),
    `${fitted.boxRel && fitted.boxRel.l} → ${zoomed.boxRel && zoomed.boxRel.l}`);

  await cdp.evaluate("document.getElementById('copyZoomVal').click()");
  await sleep(250);
  const full = await readGeo();
  check('长截图：点比例读数回到 100%（与原图 1:1）',
    full.w === full.nw && full.h === full.nh && full.zval === '100%',
    `${full.w}×${full.h} vs 原图 ${full.nw}×${full.nh} · ${full.zval}`);

  await cdp.evaluate("document.getElementById('copyFit').click()");
  await sleep(250);
  const refit = await readGeo();
  check('长截图：点「适应」收回可视区',
    refit.w <= refit.availW + 1 && refit.h <= refit.availH + 1
      && Math.abs(refit.w - fitted.w) <= 1,
    `${refit.w}×${refit.h} · ${refit.zval}`);

  console.log('\n[2g] 打码：敏感信息识别（纯函数层）');
  const mkPure = await cdp.evaluate(`(() => {
    const M = window.WBMaskMod;
    const ln = (text) => [{ id: 0, text, rect: { x: 10, y: 20, w: 200, h: 24 },
      items: [{ id: 0, text, rect: { x: 10, y: 20, w: 200, h: 24 } }] }];
    const ids = (hits) => hits.map((h) => h.ruleId).join(',');
    const off = M.defaultRuleState(); off.phone = false;
    // 一行两个框：号码单独成框时应该只盖号码那个
    const two = [{ id: 0, text: '电话 13800138000', rect: { x: 0, y: 0, w: 300, h: 24 },
      items: [{ id: 0, text: '电话', rect: { x: 0, y: 0, w: 60, h: 24 } },
              { id: 1, text: '13800138000', rect: { x: 70, y: 0, w: 200, h: 24 } }] }];
    // 号码被切成两半 → 只能靠整行兜底
    const split = [{ id: 0, text: '13800138000', rect: { x: 0, y: 0, w: 300, h: 24 },
      items: [{ id: 0, text: '1380013', rect: { x: 0, y: 0, w: 100, h: 24 } },
              { id: 1, text: '8000', rect: { x: 110, y: 0, w: 60, h: 24 } }] }];
    const merged = M.toRects([
      { rect: { x: 100, y: 10, w: 50, h: 20 }, on: true },
      { rect: { x: 145, y: 10, w: 50, h: 20 }, on: true },
    ], { pad: 0 });
    return {
      phone: ids(M.findSensitive(ln('13800138000'))),
      idcard: ids(M.findSensitive(ln('110101199003078888'))),
      bank: ids(M.findSensitive(ln('6222021234567890123'))),
      longWhole: M.findSensitive(ln('202610131234567')).length,
      longInText: M.findSensitive(ln('订单号 202610131234567')).length,
      phoneOff: M.findSensitive(ln('13800138000'), { enabled: off }).length,
      emailStill: ids(M.findSensitive(ln('a@b.com'), { enabled: off })),
      two: M.findSensitive(two).map((h) => h.scope + ':' + Math.round(h.rect.x)).join(','),
      split: M.findSensitive(split).map((h) => h.scope).join(','),
      merged: merged.length + ':' + merged[0].w,
    };
  })()`);
  check('打码 · 手机号 / 身份证 / 银行卡 各归其类（顺序优先级）',
    mkPure.phone === 'phone' && mkPure.idcard === 'idcard' && mkPure.bank === 'bank',
    `phone=${mkPure.phone} idcard=${mkPure.idcard} bank=${mkPure.bank}`);
  check('打码 · 长数字串必须整框（混在句子里的不打）',
    mkPure.longWhole === 1 && mkPure.longInText === 0,
    `整框=${mkPure.longWhole} 句内=${mkPure.longInText}`);
  check('打码 · 关掉「手机号」后 11 位数字不再被兜底规则打掉',
    mkPure.phoneOff === 0, `剩余命中 ${mkPure.phoneOff} 处`);
  check('打码 · 关掉一条规则不影响其它规则', mkPure.emailStill === 'email', mkPure.emailStill);
  check('打码 · 能落到具体文字框就不整行盖',
    mkPure.two === 'item:70', mkPure.two);
  check('打码 · 号码被切成两半时整行兜底能接住',
    mkPure.split === 'line', mkPure.split);
  check('打码 · 相邻遮盖矩形合并（半透明叠加不会叠深）',
    mkPure.merged === '1:95', mkPure.merged);

  console.log('\n[2h] 打码：识别 → 遮盖 → 导出');
  await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="mask"]').click()`);
  await cdp.waitFor("(() => { const p = document.getElementById('viewTextMask');"
    + " return !!(p && !p.hidden); })()", 10000, '打码面板可见');

  // 页面里现造一张含敏感信息的图（不依赖样例文件）
  await cdp.evaluate(`(async () => {
    const cv = document.createElement('canvas');
    cv.width = 820; cv.height = 430;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 820, 430);
    ctx.fillStyle = '#111'; ctx.font = '24px sans-serif';
    ['姓名：张三', '手机：13800138000', '身份证：110101199003078888',
     '邮箱：zhangsan@example.com', '银行卡：6222021234567890123',
     '订单号：202610131234567', '金额：1920 元'].forEach((t, i) => {
      ctx.fillText(t, 30, 52 + i * 52);
    });
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'mask_card.png', { type: 'image/png' }));
    const inp = document.getElementById('maskInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await cdp.waitFor('(() => { const M = window.WBText.mask;'
    + ' return !!(M.lines && !M.busy); })()', 90000, '打码识别完成');
  await sleep(500);

  const mk = await cdp.evaluate(`(() => {
    const M = window.WBText.mask;
    const h = M.hits.find((x) => x.label === '手机号');
    return {
      labels: M.hits.map((x) => x.label).join(','),
      count: M.hits.length,
      on: M.hits.filter((x) => x.on !== false).length,
      stats: document.getElementById('maskStats').textContent,
      // 命中区域中心 与 一处空白 的遮盖层像素
      hitPx: h ? window.WBText.maskPixel(h.rect.x + h.rect.w / 2, h.rect.y + h.rect.h / 2) : null,
      blankPx: window.WBText.maskPixel(760, 24),
      boxCount: document.querySelectorAll('#maskOverlay .tw-box').length,
    };
  })()`);
  console.log(`      命中：${mk.labels} · ${mk.stats} · 框 ${mk.boxCount}`);
  // 不断言"恰好 4 处"：OCR 若把"订单号：202610131234567"里的数字单独切成一个框，
  // 那它按规则（长数字串必须整框）**就该**被打上——那是预期的保守行为。
  check('打码 · 手机号 / 身份证 / 邮箱 / 银行卡 都被识别出来',
    ['手机号', '身份证', '邮箱', '银行卡'].every((l) => mk.labels.includes(l)),
    mk.labels);
  check('打码 · 命中框与命中项一一对应', mk.boxCount === mk.count, `框 ${mk.boxCount} / 项 ${mk.count}`);
  check('打码 · 命中区域已被盖住（色块 #111）',
    mk.hitPx && mk.hitPx[0] < 40 && mk.hitPx[1] < 40 && mk.hitPx[2] < 40 && mk.hitPx[3] > 200,
    JSON.stringify(mk.hitPx));
  check('打码 · 未命中区域没有被碰（遮盖层透明）',
    mk.blankPx && mk.blankPx[3] === 0, JSON.stringify(mk.blankPx));

  // 逐项开关：取消第一项 → 那块恢复透明；再勾回来 → 又盖上
  await cdp.evaluate("document.querySelector('#maskHits .tw-hit input').click()");
  await sleep(350);
  const off1 = await cdp.evaluate(`(() => {
    const M = window.WBText.mask;
    const h = M.hits.find((x) => x.label === '手机号');
    return { on: h.on !== false, px: window.WBText.maskPixel(h.rect.x + h.rect.w / 2, h.rect.y + h.rect.h / 2),
             stats: document.getElementById('maskStats').textContent };
  })()`);
  check('打码 · 取消勾选后该处不再被盖（其余照旧）',
    off1.on === false && off1.px && off1.px[3] === 0, `${off1.stats} · ${JSON.stringify(off1.px)}`);
  await cdp.evaluate("document.querySelector('#maskHits .tw-hit input').click()");
  await sleep(350);
  const on1 = await cdp.evaluate(`(() => {
    const M = window.WBText.mask;
    const h = M.hits.find((x) => x.label === '手机号');
    const px = window.WBText.maskPixel(h.rect.x + h.rect.w / 2, h.rect.y + h.rect.h / 2);
    return { on: h.on !== false, a: px[3] };
  })()`);
  check('打码 · 重新勾选后恢复遮盖', on1.on === true && on1.a > 200, JSON.stringify(on1));

  // 换样式：马赛克 / 模糊仍然盖住（不透明），像素与色块不同
  const styles = {};
  for (const m of ['mosaic', 'blur']) {
    await cdp.evaluate(`document.querySelector('.tw-mbtn[data-m="${m}"]').click()`);
    await sleep(450);
    styles[m] = await cdp.evaluate(`(() => {
      const M = window.WBText.mask;
      const h = M.hits.find((x) => x.label === '手机号');
      return window.WBText.maskPixel(h.rect.x + h.rect.w / 2, h.rect.y + h.rect.h / 2);
    })()`);
  }
  check('打码 · 马赛克档在该处确实画了东西',
    styles.mosaic && styles.mosaic[3] > 200, JSON.stringify(styles.mosaic));
  check('打码 · 模糊档在该处确实画了东西', styles.blur && styles.blur[3] > 200,
    JSON.stringify(styles.blur));

  // 抹字档：走引擎擦除，并要求它自报"还有没有起伏"
  await cdp.evaluate("document.querySelector('.tw-mbtn[data-m=\"erase\"]').click()");
  await cdp.waitFor('!!window.WBText.mask.eraseImg', 120000, '抹字结果就绪');
  await sleep(400);
  const er = await cdp.evaluate(`(() => {
    const M = window.WBText.mask;
    return { n: (M.leftovers || []).length,
             left: M.leftovers,
             hasImg: !!M.eraseImg };
  })()`);
  check('打码 · 抹字走引擎并返回逐块残留度量',
    er.hasImg && er.n >= 4, `块数 ${er.n} · ${JSON.stringify(er.left)}`);
  check('打码 · 纯白底上的抹字结果是干净的（残留度量接近 0）',
    er.left.filter((v) => v <= 8).length >= 3,
    JSON.stringify(er.left));

  // 导出：canvas 重编码后不应带 APP1(Exif) 段
  const exif = await cdp.evaluate(`(async () => {
    // 先造一张"带 EXIF 风格头"的输入，确认元数据不会跟着出去
    const src = document.createElement('canvas');
    src.width = 200; src.height = 120;
    const sc = src.getContext('2d');
    sc.fillStyle = '#fff'; sc.fillRect(0, 0, 200, 120);
    sc.fillStyle = '#111'; sc.font = '20px sans-serif'; sc.fillText('13800138000', 12, 50);
    const blob = await new Promise((r) => src.toBlob(r, 'image/jpeg', 0.92));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let app1 = false, i = 2;
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xFF) break;
      const mk2 = buf[i + 1];
      if (mk2 === 0xD8 || mk2 === 0x01 || (mk2 >= 0xD0 && mk2 <= 0xD7)) { i += 2; continue; }
      if (mk2 === 0xDA) break;
      const len = (buf[i + 2] << 8) | buf[i + 3];
      if (mk2 === 0xE1) app1 = true;
      i += 2 + len;
    }
    return { bytes: buf.length, app1 };
  })()`);
  check('打码 · 导出的 JPEG 不含 APP1(Exif) 段（canvas 重编码天然抹掉元信息）',
    exif.app1 === false && exif.bytes > 500, `${exif.bytes} bytes · app1=${exif.app1}`);

  console.log('\n[2i] 翻译：analyze → 上游翻译 → 复用 applyEdits 原位重绘');
  await cdp.evaluate(`document.querySelector('.tw-tab[data-mode="translate"]').click()`);
  await cdp.waitFor("(() => { const p = document.getElementById('viewTextTranslate');"
    + " return !!(p && !p.hidden); })()", 10000, '翻译面板可见');

  // 上游**不测真实服务**（生图 API 失效的教训在前）：把 /api/text/translate 拦下来
  // 返回固定译文。第一行刻意给一段超长译文，用来验证「过宽时缩字号」这条
  // 已有通路真的被复用上了。
  await cdp.evaluate(`(() => {
    if (window.__trOrigFetch) return true;
    window.__trOrigFetch = window.fetch;
    window.__trCalls = 0;
    window.fetch = function (url, opt) {
      const u = String(url && url.url ? url.url : url);
      if (u.indexOf('/api/text/translate') >= 0 && (!opt || !opt.method || opt.method === 'POST')) {
        window.__trCalls++;
        const body = JSON.parse((opt && opt.body) || '{}');
        const texts = (body.texts || []).map((t, i) => (i === 0
          ? ('A deliberately overlong translation used to verify that the existing auto-fit shrink path is reused. '.repeat(2))
          : ('EN:' + t)));
        return Promise.resolve(new Response(JSON.stringify({
          texts, model: 'mock-text-model', from: body.from, to: body.to,
          finish_reason: 'stop', truncated: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return window.__trOrigFetch.apply(this, arguments);
    };
    return true;
  })()`);

  // 页面里现造一张多行中文图（不依赖样例文件与外部字体）
  await cdp.evaluate(`(async () => {
    const cv = document.createElement('canvas');
    cv.width = 760; cv.height = 360;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 760, 360);
    ctx.fillStyle = '#111'; ctx.font = '26px sans-serif';
    ['你好世界', '这是一个测试', '图片翻译功能', '第四行文字'].forEach((t, i) => {
      ctx.fillText(t, 30, 58 + i * 62);
    });
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'translate_card.png', { type: 'image/png' }));
    const inp = document.getElementById('trInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await cdp.waitFor('(() => { const T = window.WBText.translate;'
    + ' return !!(T.items && !T.busy); })()', 120000, '翻译模式识别完成');
  await sleep(300);

  const t0 = await cdp.evaluate(`(() => {
    const T = window.WBText.translate;
    return {
      n: T.items.length,
      pairs: window.WBText.trPairs().length,
      firstSrc: T.pairs[0] ? T.pairs[0].src : '',
      runEnabled: !document.getElementById('trRunBtn').disabled,
      viewHidden: document.getElementById('trView').hidden,
    };
  })()`);
  console.log(`      识别 ${t0.n} 行 · 首行「${t0.firstSrc}」`);
  check('翻译 · 走 analyze 通道拿到 items 并逐行展开', t0.n > 0 && t0.pairs === t0.n,
    `${t0.n} 行 / ${t0.pairs} 对照项`);
  check('翻译 · 识别结果与「取文字」同一份（首行是完整短语，未被切碎）',
    t0.firstSrc.length >= 2, t0.firstSrc);
  check('翻译 · 未翻译前没有译文可看，翻译按钮已可用', t0.runEnabled === true && t0.viewHidden === true);

  // 点「翻译」：内部会走 mock 上游 → 写回 edit → 调 /api/apply 重绘
  await cdp.evaluate("document.getElementById('trRunBtn').click()");
  await cdp.waitFor('(() => { const T = window.WBText.translate;'
    + ' return !!(T.outUrl && !T.busy); })()', 180000, '翻译 + 重绘完成');
  await sleep(500);

  const t1 = await cdp.evaluate(`(() => {
    const T = window.WBText.translate;
    const img = document.getElementById('trImg');
    const sentBox = document.getElementById('trSentBox');
    return {
      calls: window.__trCalls,
      dst: T.pairs.map((p) => p.dst),
      fitted: T.pairs.filter((p) => p.fitted).length,
      applied: window.WBText.trPairs().filter((p) => p.on !== false).length,
      edits: Object.keys(window.WBText.trEdits()).length,
      imgIsResult: img.src === T.outUrl,
      toggleShown: document.getElementById('trView').hidden === false,
      saveEnabled: !document.getElementById('trSavePng').disabled,
      toEditEnabled: !document.getElementById('trToEdit').disabled,
      sentShown: !sentBox.hidden,
      sentText: (document.getElementById('trSent').textContent || '').split('\\n')[0],
      stats: document.getElementById('trStats').textContent,
    };
  })()`);
  console.log(`      上游调用 ${t1.calls} 次 · ${t1.stats}`);
  check('翻译 · 上游译文写回了每一行（mock 前缀可见）',
    t1.dst.length === t0.n && t1.dst.every((d) => d && d.trim().length),
    JSON.stringify(t1.dst.slice(0, 2)));
  check('翻译 · 译文原样进入 edit（buildTrEdits 逐行生成）',
    t1.edits === t0.n, `${t1.edits} 条 edit`);
  check('翻译 · 长译文触发了「过宽缩字号」（复用现有 auto_fit 通路）',
    t1.fitted >= 1, `缩字号 ${t1.fitted} 处`);
  check('翻译 · 重绘结果已显示（画布换成译文图，原图/译文可切）',
    t1.imgIsResult === true && t1.toggleShown === true);
  check('翻译 · 导出口已打开', t1.saveEnabled === true && t1.toEditEnabled === true);
  check('翻译 · 「本次发送出去的文字」把实际内容亮了出来',
    t1.sentShown === true && t1.sentText.startsWith('1. '), t1.sentText);

  // 原图 / 译文 切换：换的是同一张 <img> 的 src，尺寸一致、比例不该被重置
  await cdp.evaluate("document.querySelector('#trView .tw-tbtn[data-v=\"source\"]').click()");
  await sleep(300);
  const tSrc = await cdp.evaluate(`(() => {
    const T = window.WBText.translate, img = document.getElementById('trImg');
    return { isSource: img.src === T.objectUrl, k: document.querySelector('#trZoomVal').textContent };
  })()`);
  await cdp.evaluate("document.querySelector('#trView .tw-tbtn[data-v=\"result\"]').click()");
  await sleep(300);
  const tRes = await cdp.evaluate(`(() => {
    const T = window.WBText.translate, img = document.getElementById('trImg');
    return { isResult: img.src === T.outUrl, k: document.querySelector('#trZoomVal').textContent };
  })()`);
  check('翻译 · 切到「原图」看到的是原图', tSrc.isSource === true, `缩放 ${tSrc.k}`);
  check('翻译 · 切回「译文」看到的还是译文图（且缩放没被重置）',
    tRes.isResult === true && tRes.k === tSrc.k, `${tSrc.k} → ${tRes.k}`);

  // 手改译文：改完应当自动重绘（去抖 650ms）
  const before = await cdp.evaluate('window.WBText.translate.outUrl.length');
  await cdp.evaluate(`(() => {
    const ta = document.querySelector('#trPairs .tw-pair textarea');
    ta.value = 'Edited by hand';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await cdp.waitFor(`window.WBText.translate.pairs[0].dst === 'Edited by hand'`, 5000, '手改译文已写入状态');
  await sleep(1800);
  const t2 = await cdp.evaluate(`(() => {
    const T = window.WBText.translate;
    return { dst: T.pairs[0].dst, len: T.outUrl.length, applied: T.pairs[0].applied };
  })()`);
  check('翻译 · 手动改译文后自动重绘', t2.dst === 'Edited by hand' && t2.applied === true && t2.len > 1000,
    `${before} → ${t2.len} bytes`);

  // 交接：发送到「无痕改字」继续精修
  await cdp.evaluate("document.getElementById('trToEdit').click()");
  await cdp.waitFor(`(() => { const e = document.getElementById('viewEdit');`
    + ` return !!(e && !e.hidden && window.WBEdit.items && window.WBEdit.items.length); })()`,
    90000, '改字视图接管了翻译结果');
  const t3 = await cdp.evaluate(`(() => ({
    view: document.getElementById('viewEdit').hidden === false,
    items: window.WBEdit.items.length,
    edits: Object.keys(window.WBEdit.edits).length,
    status: (document.getElementById('statusText') || {}).textContent || '',
  }))()`);
  check('翻译 · 能交接到「无痕改字」继续精修（同一会话，id 对得上）',
    t3.view === true && t3.items === t0.n && t3.edits >= 1,
    `items ${t3.items} · edits ${t3.edits}`);

  console.log('\n[3] 点「作品库」');
  const c2 = await clickNav('projects', 'images');
  const s2 = await viewState();
  check('切到作品库视图', s2.images === true && s2.projVisible === true,
    `${c2.ms}ms · hash="${s2.hash}"`);
  check('作品库切换也没有重新加载页面', docLoads === loadsAfterFirst, `文档加载 ${docLoads} 次`);

  console.log('\n[4] 点回「无痕改字」');
  const c3 = await clickNav('edit', 'edit');
  const s3 = await viewState();
  check('切回改字视图', s3.edit === true && s3.images === false,
    `${c3.ms}ms · hash="${s3.hash}"`);
  check('切回也没有重新加载页面', docLoads === loadsAfterFirst, `文档加载 ${docLoads} 次`);
  check('生成视图已隐藏', s3.images === false);

  console.log('\n[5] 深链与兼容入口');
  // 「四个工具合并成一个」之后，老 hash 仍要能落地，并当场归一到 #generate
  await cdp.send('Page.navigate', { url: `${BASE}/#combine` });
  await sleep(2500);
  const s4 = await viewState();
  check('老深链 /#combine 直接落到生成视图', s4.images === true, `hash="${s4.hash}"`);
  check('老 hash 已归一到 #generate', s4.hash === '#generate', `hash="${s4.hash}"`);

  await cdp.send('Page.navigate', { url: `${BASE}/image#projects` });
  await sleep(3000);
  const s5 = await viewState();
  check('老链接 /image#projects 跳到同一页且保留 hash',
    s5.path === '/' && s5.hash === '#projects' && s5.images === true,
    `${s5.path}${s5.hash}`);

  await cdp.send('Page.navigate', { url: `${BASE}/#text-translate` });
  await sleep(2500);
  const s6 = await viewState();
  check('深链 /#text-translate 直达翻译模式',
    s6.text === true && s6.transVisible === true && s6.copyVisible === false,
    `hash="${s6.hash}"`);
  const hl = await cdp.evaluate(
    "(() => { const a = document.querySelector('.sb-item.on'); return a ? a.dataset.key : ''; })()");
  check('模式深链下侧栏仍高亮「文字工坊」', hl === 'text', `高亮项=${hl}`);
  check('深链切换也没有重新加载页面以外的副作用', s6.edit === false && s6.images === false);

  await cdp.send('Page.navigate', { url: `${BASE}/#text` });
  await sleep(2500);
  const s7 = await viewState();
  check('裸 #text 落到默认模式，且 hash 不被悄悄改写',
    s7.text === true && s7.copyVisible === true && s7.hash === '#text', `hash="${s7.hash}"`);

  console.log('\n[6] 双向切换耗时（采样 5 次取平均）');
  const times = [];
  for (let i = 0; i < 5; i++) {
    await cdp.send('Runtime.evaluate', { expression: `location.hash = '#edit'` });
    await sleep(400);
    const t0 = Date.now();
    await cdp.send('Runtime.evaluate', { expression: `location.hash = '#generate'` });
    await cdp.waitFor("(() => { const i = document.getElementById('viewImages');"
      + " return i && !i.hidden && getComputedStyle(i).display !== 'none'; })()", 10000);
    times.push(Date.now() - t0);
    await sleep(300);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  check('改字 → 生成 切换耗时很短', avg < 500,
    `平均 ${avg}ms（样本 ${times.join('/')}）· 对比合并前切回改字 5770ms`);

  console.log('\n' + '='.repeat(74));
  console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
  if (FAIL.length) FAIL.forEach((f) => console.log(`  ✗ ${f}`));
  if (pageErrors.length) {
    console.log('页面侧错误：');
    pageErrors.slice(0, 6).forEach((e) => console.log(`  ${e.slice(0, 150)}`));
  }
  console.log('='.repeat(74));
  process.exitCode = FAIL.length ? 1 : 0;
} catch (err) {
  console.error('\n验证中断：', err.message);
  if (pageErrors.length) pageErrors.slice(0, 6).forEach((e) => console.error(`  ${e.slice(0, 150)}`));
  process.exitCode = 1;
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
