/**
 * 前端修复验证（真实浏览器直连线上）
 *
 * 验四件事：
 *   1. 进页面不再报「无法连接后端服务」（之前裸 fetch 拿 /api/health、/api/fonts 导致）
 *   2. 字体下拉里有东西（之前恒为空，只有"自动匹配"）
 *   3. 导入字体走本地：注册进页面 + 存进 Cache Storage，且没有任何上传请求
 *   4. 本机字体扫描的可用性（授权被拒/浏览器不支持都算预期内，只如实报告）
 *
 *   node tools/probe_ui.mjs [--base https://ps.ysw69.dpdns.org]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'https://ps.ysw69.dpdns.org').replace(/\/$/, '');
const DEBUG_PORT = 9348;
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
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`CDP 超时 ${method}`)); }, 600000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面执行出错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async waitFor(expr, timeout = 30000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) {}
      await sleep(300);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) { console.error('找不到 Edge'); process.exit(1); }
// --profile <dir>：复用同一个浏览器配置目录。跑一次之后模型就进了 Cache Storage，
// 后续几次验证不必再重下 39MB（不加这个参数则每次用临时目录，跑完即删）。
const fixedProfile = arg('profile', '');
const profile = fixedProfile || path.join(os.tmpdir(), `wb-ui-${Date.now()}`);
const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--disable-extensions',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch (_) {}
  await sleep(400);
}
if (!wsUrl) { child.kill(); console.error('浏览器未就绪'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
const cdp = new CDP(ws);

// 记录页面发出的所有请求，用来确认"字体没被传到服务器"
const uploads = [];
cdp.on('Network.requestWillBeSent', (p) => {
  if (p.request?.method && p.request.method !== 'GET') {
    uploads.push(`${p.request.method} ${new URL(p.request.url).pathname}`);
  }
});
const pageErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(
  p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''));

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

try {
  console.log('='.repeat(74));
  console.log(`前端修复验证   目标=${BASE}`);
  console.log('='.repeat(74));

  await cdp.send('Page.navigate', { url: `${BASE}/` });

  console.log('\n[1] 页面初始化（首次会下载 39MB 模型）');
  await cdp.waitFor('!!window.WBLocal', 40000, '引导脚本就绪');
  // 初始化会依次调 /api/health 与 /api/fonts，两者都要等本地引擎就绪才返回。
  // 注意：字体下拉（#selFont）只在**有图被选中**时才重建，所以这里不能拿它当就绪信号。
  await cdp.waitFor('window.WBLocal.ready === true', 420000, '本地引擎就绪');

  // 状态栏文案可能被后续流程覆盖 —— 例如复用了浏览器配置目录时，
  // 会自动恢复上次的编辑并写「已恢复上次的编辑」。所以这里判"没有报错"，
  // 而不是死盯某个字面（踩过一次，误报成失败）。
  const BAD = /无法连接后端服务|失败|超时|准备中/;
  const anyError = await cdp.evaluate(
    `(document.getElementById('statusText')||{}).textContent || ''`);
  check('状态栏没有报错', !BAD.test(anyError), `「${anyError}」`);

  const init = await cdp.evaluate(`(() => ({
    statusText: (document.getElementById('statusText') || {}).textContent || '',
    statusMeta: (document.getElementById('statusMeta') || {}).textContent || '',
    footLeft: (document.getElementById('footLeft') || {}).textContent || '',
  }))()`);
  check('状态栏不再提示「无法连接后端服务」',
    !/无法连接后端服务/.test(init.statusText),
    `「${init.statusText}」${init.statusMeta ? ' · ' + init.statusMeta : ''}`);
  check('展示的状态是正常状态（就绪 / 已恢复上次编辑）',
    /就绪|已恢复/.test(init.statusText), init.footLeft || init.statusMeta);

  const hf = await cdp.evaluate(`(async () => {
    const L = window.WBLocal;
    const h = await L.handle('/api/health', null);
    const f = await L.handle('/api/fonts', null);
    return { backend: h.ocr_backend, fontCount: h.font_count,
             families: f.families.length, imported: f.user_count, scanned: f.scanned_count };
  })()`);
  check('/api/health 走通并带 font_count', hf.backend === 'browser-wasm' && hf.fontCount > 0,
    `backend=${hf.backend} font_count=${hf.fontCount}`);
  check('/api/fonts 返回 families（前端要的字段）', hf.families > 0,
    `families=${hf.families} imported=${hf.imported} scanned=${hf.scanned}`);

  console.log('\n[2] 导入字体（必须只留在浏览器）');
  const ttf = fs.readdirSync('fonts').find((f) => /\.(ttf|otf)$/i.test(f));
  if (!ttf) {
    check('找到本地字体样本来测试导入', false, 'fonts/ 下没有 ttf');
  } else {
    const b64 = fs.readFileSync(path.join('fonts', ttf)).toString('base64');
    const before = uploads.length;
    const res = await cdp.evaluate(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const file = new File([u8], ${JSON.stringify(ttf)}, { type: 'font/ttf' });
      const fd = new FormData();
      fd.append('files', file, file.name);
      const r = await window.WBLocal.handle('/api/fonts/upload', fd);
      const keys = await caches.open('wb-ps-fonts-v1').then(c => c.keys()).then(ks => ks.map(k => new URL(k.url).pathname));
      return { added: r.added.length, family: r.added[0] ? r.added[0].family : '',
               families: r.families.length, userCount: r.user_count, errors: r.errors,
               keys, uploadedToServer: r.uploaded_to_server };
    })()`);
    check('导入成功', res.added === 1 && (res.errors || []).length === 0,
      `added=${res.added} family=${res.family} errors=${JSON.stringify(res.errors)}`);
    check('字体字节已缓存进浏览器（Cache Storage）', res.keys.length >= 1, res.keys.join(', '));
    check('导入的字体进入可用清单', res.userCount >= 1 && res.families > 0,
      `user_count=${res.userCount} 合计 ${res.families} 个字体族`);
    check('导入过程没有向服务器发任何写请求', uploads.length === before,
      `新增请求：${JSON.stringify(uploads.slice(before))}`);

    // 刷新后应该还在（Cache Storage 的意义就在这）
    await cdp.send('Page.reload');
    await cdp.waitFor('window.WBLocal && window.WBLocal.ready === true', 300000, '刷新后引擎就绪');
    const after = await cdp.evaluate(`(async () => {
      const f = await window.WBLocal.handle('/api/fonts', null);
      // families 是 [{name,bold,user,files}]（与 Python 版同形），不是字符串数组
      const names = (f.families || []).map(x => (typeof x === 'string' ? x : x.name));
      return { userCount: f.user_count, names: names.length,
               hasIt: names.includes(${JSON.stringify(res.family)}) };
    })()`);
    check('刷新后导入的字体仍在（持久化生效）', after.userCount >= 1 && after.hasIt,
      `user_count=${after.userCount} 清单里可见=${after.hasIt}`);
  }

  console.log('\n[3] 走真实选图流程，看字体下拉是否被填满');
  const sample = path.resolve('samples/test_card.png');
  if (!fs.existsSync(sample)) {
    check('找到样例图', false, sample);
  } else {
    const imgB64 = fs.readFileSync(sample).toString('base64');
    await cdp.evaluate(`(() => {
      const bin = atob(${JSON.stringify(imgB64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const file = new File([u8], 'test_card.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, false);

    // 字体下拉只在**选中某个文字块**时才会重建（编辑面板是点开才出现的），
    // 所以这里点一下结果列表的第一行 —— 也就是用户的真实操作路径。
    //
    // 注意两种起始状态：全新会话没有文字块，要先等识别；复用配置目录时
    // 页面可能恢复了上次的编辑、列表里已经有行。所以先等"有行就点"，
    // 而不是无条件先选图。
    const rows = async () => cdp.evaluate("document.querySelectorAll('#itemList .item').length").catch(() => 0);

    let hasRows = await rows();
    if (!hasRows) {
      await cdp.waitFor("document.querySelectorAll('#itemList .item').length > 0", 180000,
        '识别结果列表出现');
      hasRows = await rows();
    }
    check('识别结果列表有文字块', hasRows > 0, `${hasRows} 行`);

    // 点击要容错：列表可能在两次调用之间被重绘成空（例如识别刚完成又刷新了一次）
    let clicked = false;
    for (let i = 0; i < 20 && !clicked; i++) {
      clicked = await cdp.evaluate(`(() => {
        const el = document.querySelector('#itemList .item');
        if (!el) return false;
        el.click();
        return true;
      })()`, false).catch(() => false);
      if (!clicked) await sleep(500);
    }
    check('能点开某个文字块的编辑面板', clicked === true);

    await cdp.waitFor("document.querySelectorAll('#selFont option').length > 1", 60000,
      '字体下拉被填充');
    const sel = await cdp.evaluate(`(() => {
      const opts = [...document.querySelectorAll('#selFont option')];
      const texts = opts.map(o => o.textContent.trim());
      // 分组标题（optgroup）单独统计，选项文本为空的要揪出来
      const groups = [...document.querySelectorAll('#selFont optgroup')].map(g => g.label);
      return { n: opts.length, sample: texts.slice(0, 5),
               // 「自动匹配」之外的空标签 = 上次那个 bug（渲染成一片空白）
               empty: texts.filter((t, i) => i > 0 && !t).length,
               groups,
               user: (document.getElementById('userFontCount') || {}).textContent || '',
               filter: !!document.getElementById('fontFilter'),
               items: document.querySelectorAll('#itemList .item').length,
               status: (document.getElementById('statusText') || {}).textContent || '' };
    })()`);
    check('选中文字块后字体下拉被填满', sel.n > 1,
      `${sel.n} 项：${sel.sample.join(' / ')}`);
    check('下拉选项都有可见文字（不是空标签）', sel.empty === 0,
      sel.empty ? `${sel.empty} 个空标签` : '标签均非空');
    check('下拉按来源分组', sel.groups.length > 1, sel.groups.join(' / '));
    check('有字体搜索框', sel.filter === true);
    check('界面显示已导入字体数', /已导入/.test(sel.user), sel.user || '(空)');

    // 搜索框：输入关键词后候选项应该收窄，且仍然有可见文字
    const filtered = await cdp.evaluate(`(() => {
      const box = document.getElementById('fontFilter');
      box.value = 'yahei';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(r => setTimeout(() => {
        const opts = [...document.querySelectorAll('#selFont option')];
        r({ n: opts.length, texts: opts.map(o => o.textContent.trim()).filter(Boolean).slice(0, 4),
            empty: opts.filter(o => !o.textContent.trim()).length });
      }, 400));
    })()`);
    check('搜索能收窄候选且不产生空标签',
      filtered.n >= 1 && filtered.empty === 0 && filtered.n < sel.n,
      `「yahei」→ ${filtered.n} 项：${filtered.texts.join(' / ')}`);
  }

  console.log('\n[4] 本地导出（原来裸 fetch /api/export 必然 404）');
  if (fs.existsSync(sample)) {
    const imgB64 = fs.readFileSync(sample).toString('base64');
    const exp = await cdp.evaluate(`(async () => {
      const bin = atob(${JSON.stringify(imgB64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const file = new File([u8], 'test_card.png', { type: 'image/png' });
      const fd = new FormData();
      fd.append('file', file, 'test_card.png');
      fd.append('merge_lines', 'true');
      const an = await window.WBLocal.handle('/api/analyze', fd);
      const edits = {};
      edits[String(an.items[0].id)] = { text: '无痕改字' };
      const base = { session_id: an.session_id, edits, new_items: [] };
      const png = await window.WBLocal.exportBlob({ ...base, format: 'png', quality: 95 });
      const jpg = await window.WBLocal.exportBlob({ ...base, format: 'jpg', quality: 90 });
      return { count: an.count, pngBytes: png.bytes, pngType: png.blob.type,
               pngMagic: await png.blob.slice(0, 8).arrayBuffer().then(b =>
                 [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(' ')),
               jpgBytes: jpg.bytes, jpgType: jpg.blob.type,
               jpgMagic: await jpg.blob.slice(0, 2).arrayBuffer().then(b =>
                 [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(' ')),
               w: png.width, h: png.height };
    })()`);
    check('PNG 导出成功且是合法 PNG（文件头 89 50 4e 47）',
      exp.pngBytes > 1000 && /^89 50 4e 47/.test(exp.pngMagic),
      `${(exp.pngBytes / 1024).toFixed(0)} KB · ${exp.pngType} · ${exp.w}×${exp.h}`);
    check('JPG 导出成功且是合法 JPEG（文件头 ff d8）',
      exp.jpgBytes > 1000 && /^ff d8/.test(exp.jpgMagic),
      `${(exp.jpgBytes / 1024).toFixed(0)} KB · ${exp.jpgType}`);
  }

  console.log('\n[5] 扫描本机字体');
  await cdp.send('Browser.grantPermissions', {
    origin: BASE, permissions: ['localFonts'],
  }).catch(() => { /* 该协议名不支持就算了，按实际结果报告 */ });
  const scan = await cdp.evaluate(`window.WBLocal.handle('/api/fonts/scan', null)`);
  const sc = scan.scan || {};
  if (!sc.supported) console.log(`      （不支持：${sc.error}）`);
  else if (sc.denied) console.log('      （授权被拒 —— 无头环境下正常）');
  else console.log(`      扫到 ${sc.count} 个本机字体族；合计可用 ${scan.families.length}`);
  check('扫描接口能返回结构化结果', typeof sc.supported === 'boolean',
    JSON.stringify({ supported: sc.supported, denied: sc.denied, count: sc.count }));

  console.log('\n' + '='.repeat(74));
  console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
  if (FAIL.length) FAIL.forEach((f) => console.log(`  ✗ ${f}`));
  if (pageErrors.length) {
    console.log('页面侧错误：');
    pageErrors.slice(0, 5).forEach((e) => console.log(`  ${String(e).split('\n')[0]}`));
  }
  console.log('='.repeat(74));
  process.exitCode = FAIL.length ? 1 : 0;
} catch (err) {
  console.error('\n验证中断：', err.message);
  if (pageErrors.length) pageErrors.slice(0, 6).forEach((e) => console.error(`  ${String(e).split('\n')[0]}`));
  process.exitCode = 1;
} finally {
  child.kill();
  if (!fixedProfile) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}
