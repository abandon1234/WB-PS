/**
 * 验证：自由生成的参考图 + 提示词清空
 *
 *   node tools/probe_prompt.mjs [--base http://127.0.0.1:8788] [--profile <dir>]
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
const PORT = 9366;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASS = [], FAIL = [];
const check = (name, ok, detail = '') => {
  (ok ? PASS : FAIL).push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 120000);
    });
  }
  async evaluate(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 30000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.evaluate(expr)) return true; } catch (_) {}
      await sleep(250);
    }
    throw new Error(`等待超时：${label}`);
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-pr-${Date.now()}`);
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

try {
  await cdp.send('Page.navigate', { url: `${BASE}/#create` });
  await cdp.waitFor("!!window.WBImage && window.WBImage.ready", 180000, '模块就绪');
  await cdp.waitFor("(() => { const i = document.getElementById('viewImages');"
    + " return !!(i && !i.hidden && getComputedStyle(i).display !== 'none'); })()", 30000, '生成视图可见');
  console.log('='.repeat(72));
  console.log('自由生成：参考图 + 提示词清空');
  console.log('='.repeat(72));

  console.log('\n[1] 参考图区应当可用（原来 refs.max=0，传图会被拒）');
  const zone = await cdp.evaluate(`(() => {
    const dz = document.getElementById('dropzone');
    const inp = document.getElementById('refInput');
    const note = document.getElementById('refNote');
    const vis = (el) => !!(el && !el.hidden && getComputedStyle(el).display !== 'none');
    return {
      dropVisible: vis(dz),
      noteVisible: vis(note),
      accept: inp ? inp.accept : '',
      multiple: inp ? inp.multiple : false,
      hint: dz ? (dz.querySelector('.dz-inner span') || {}).textContent : '',
      counter: (document.getElementById('refCount') || {}).textContent || '',
    };
  })()`);
  check('上传框可见（不再是隐藏的）', zone.dropVisible === true);
  check('不再显示"不需要参照图"的说明', zone.noteVisible === false);
  check('支持多选', zone.multiple === true, zone.accept);
  check('提示语表明是选填', /选填/.test(zone.hint || ''), zone.hint);
  check('计数上限显示为 4', /\/4$/.test(zone.counter || ''), zone.counter);

  console.log('\n[2] 实际塞一张图，看是否被接受');
  const png = fs.readFileSync('samples/test_card.png');
  const b64 = png.toString('base64');
  // 先记下当前张数：复用浏览器配置时可能恢复了上次的参考图草稿，
  // 断言要基于"增量"而不是硬等 1/4（否则会误报）。
  const beforeCount = await cdp.evaluate(
    "parseInt(((document.getElementById('refCount')||{}).textContent||'0/4').split('/')[0], 10) || 0");
  const added = await cdp.evaluate(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'ref1.png', { type: 'image/png' }));
    const inp = document.getElementById('refInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, false);
  await sleep(1500);
  const afterAdd = await cdp.evaluate(`(() => ({
    counter: (document.getElementById('refCount') || {}).textContent || '',
    strip: (() => { const s = document.getElementById('refStrip');
      return s ? s.querySelectorAll('*').length : 0; })(),
    stripVisible: (() => { const s = document.getElementById('refStrip');
      return !!(s && !s.hidden && getComputedStyle(s).display !== 'none'); })(),
    toast: (document.getElementById('toastWrap') || {}).innerText || '',
  }))()`);
  const nowCount = parseInt(String(afterAdd.counter).split('/')[0], 10) || 0;
  check('参考图被接受（张数 +1）', nowCount === beforeCount + 1,
    `${beforeCount} → ${afterAdd.counter} · 提示=${JSON.stringify((afterAdd.toast || '').slice(0, 50))}`);
  check('缩略图区显示出来', afterAdd.stripVisible === true, `${afterAdd.strip} 个节点`);

  console.log('\n[3] 提示词清空');
  await cdp.evaluate(`(() => {
    const ta = document.getElementById('prompt');
    ta.value = '一只坐在窗台的橘猫';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, false);
  await sleep(400);
  const withText = await cdp.evaluate(`(() => ({
    len: document.getElementById('prompt').value.length,
    count: (document.getElementById('promptCount') || {}).textContent || '',
    btnHidden: (document.getElementById('btnClearPrompt') || {}).hidden,
  }))()`);
  check('有内容时显示字数', /字/.test(withText.count || ''), withText.count);
  check('有内容时清空按钮出现', withText.btnHidden === false);

  await cdp.evaluate("document.getElementById('btnClearPrompt').click()", false);
  await sleep(500);
  const afterClear = await cdp.evaluate(`(() => ({
    len: document.getElementById('prompt').value.length,
    count: (document.getElementById('promptCount') || {}).textContent || '',
    btnHidden: (document.getElementById('btnClearPrompt') || {}).hidden,
    draft: (() => { try { return JSON.parse(localStorage.getItem('wb-image-draft') || '{}'); }
      catch (e) { return {}; } })(),
  }))()`);
  check('点击后提示词被清空', afterClear.len === 0, `剩余 ${afterClear.len} 字`);
  check('清空后按钮自动隐藏', afterClear.btnHidden === true);
  check('清空后回显"可选"', /可选/.test(afterClear.count || ''), afterClear.count);

  console.log('\n[4] Esc 快捷键');
  await cdp.evaluate(`(() => {
    const ta = document.getElementById('prompt');
    ta.value = '测试内容';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return true;
  })()`, false);
  await sleep(300);
  await cdp.evaluate(`(() => {
    const ta = document.getElementById('prompt');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`, false);
  await sleep(400);
  const afterEsc = await cdp.evaluate("document.getElementById('prompt').value.length");
  check('Esc 能清空有内容的提示词', afterEsc === 0, `剩余 ${afterEsc} 字`);

  console.log('\n[5] 重新计算：仍按工具切换保留各自草稿');
  await cdp.evaluate(`(async () => {
    // 切到图像融合再切回来，看提示词是否按工具隔离
    if (window.WBImage && window.WBImage.showKey) window.WBImage.showKey('combine');
    return true;
  })()`, true);
  await sleep(1200);
  const switched = await cdp.evaluate(`(() => ({
    title: (document.getElementById('toolTitle') || {}).textContent || '',
    prompt: (document.getElementById('prompt') || {}).value || '',
    refCount: (document.getElementById('refCount') || {}).textContent || '',
  }))()`);
  check('切到图像融合后界面已更新', /融合/.test(switched.title || ''), switched.title);

  await cdp.evaluate(`(() => { if (window.WBImage) window.WBImage.showKey('create'); return true; })()`, true);
  await sleep(1200);
  const back = await cdp.evaluate(`(() => ({
    title: (document.getElementById('toolTitle') || {}).textContent || '',
    hint: (() => { const dz = document.getElementById('dropzone');
      return dz ? (dz.querySelector('.dz-inner span') || {}).textContent : ''; })(),
  }))()`);
  check('切回自由生成，"选填"提示仍然正确', /选填/.test(back.hint || ''), back.hint);

  console.log('\n' + '='.repeat(72));
  console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
  if (FAIL.length) FAIL.forEach((f) => console.log(`  ✗ ${f}`));
  console.log('='.repeat(72));
  process.exitCode = FAIL.length ? 1 : 0;
} catch (err) {
  console.error('\n验证中断：', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
