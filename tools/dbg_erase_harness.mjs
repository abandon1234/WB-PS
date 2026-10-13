/**
 * 最小测台：直接调本地引擎的 /api/text/erase，跳过 OCR。
 * 用途：秒级复现「抹字」取色/度量问题（不必跑全量 probe_views）。
 *
 *   node tools/dbg_erase_harness.mjs [--base http://127.0.0.1:8794] [--profile <dir>]
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
const BASE = arg('base', 'http://127.0.0.1:8794').replace(/\/$/, '');
const fixedProfile = arg('profile', '');
const PORT = 9356;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.resolve('tools/.dbg-out');
fs.mkdirSync(OUT, { recursive: true });

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
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`超时 ${method}`)); }, 300000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

const profile = fixedProfile || path.join(os.tmpdir(), `wb-erase-${Date.now()}`);
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
  await cdp.send('Page.navigate', { url: BASE + '/' });
  for (let i = 0; i < 100; i++) {
    const ok = await cdp.evaluate('!!window.WBLocal').catch(() => false);
    if (ok) break;
    await sleep(300);
  }
  console.log('页面已加载，开始装配引擎…');
  await cdp.evaluate(`(async () => {
    window.__prog = [];
    window.WBLocal.progress = (p) => window.__prog.push(p && p.label ? p.label : '');
    try { await window.WBLocal.ensure(); window.__ens = 'ok'; }
    catch (e) { window.__ens = 'ERR: ' + (e && e.message); }
    return true;
  })()`);
  for (let i = 0; i < 400; i++) {
    const st = await cdp.evaluate('({ ens: window.__ens, cv: !!(window.WBLocal.engine && window.WBLocal.engine.cv), last: (window.__prog||[]).slice(-1)[0] || "" })').catch(() => null);
    if (st && (st.cv || (st.ens && String(st.ens).startsWith('ERR')))) {
      console.log('  装配结果:', JSON.stringify(st));
      if (!st.cv) throw new Error('引擎装配失败: ' + st.ens);
      break;
    }
    await sleep(300);
  }
  const ready = await cdp.evaluate('!!(window.WBLocal && window.WBLocal.engine && window.WBLocal.engine.cv)');
  if (!ready) throw new Error('引擎未就绪（window.WBLocal.engine 没出来）');
  console.log('引擎就绪，开始造图与擦除…');

  // 造多张等价图（覆盖纯色/深色/灰底/渐变/纹理/残影带），并把输入图带出来
  await cdp.evaluate(`(async () => {
    const NUM = '131307010252000052610010735829';
    const mk = (draw) => {
      const cv = document.createElement('canvas');
      cv.width = 660; cv.height = 260;
      draw(cv.getContext('2d'));
      return cv;
    };
    const put = (ctx) => {
      ctx.font = '20px monospace'; ctx.fillStyle = '#222';
      ctx.fillText(NUM, 30, 146);
    };
    const bands = (ctx, color) => {
      ctx.fillStyle = color;
      const dash = [14, 9, 31, 17, 6, 25, 40, 12, 22, 8, 35, 19, 11, 28];
      let x = 32;
      for (let i = 0; i < dash.length; i++) { ctx.fillRect(x, 136 + (i % 4) * 3, dash[i], 2); x += dash[i] + 6; }
    };
    const ctrl = (ctx, col) => {
      ctx.font = '20px sans-serif'; ctx.fillStyle = col;
      ctx.fillText('收款方示例商户', 30, 66);
      ctx.fillText('备注本行仅作对照', 30, 216);
    };
    const scenes = {
      solid: mk((c) => {
        c.fillStyle = '#fff'; c.fillRect(0, 0, 660, 260);
        ctrl(c, '#333'); put(c); bands(c, '#ececec');
      }),
      dark: mk((c) => {
        c.fillStyle = '#202020'; c.fillRect(0, 0, 660, 260);
        ctrl(c, '#c8c8c8'); c.font = '20px monospace'; c.fillStyle = '#e8e8e8';
        c.fillText(NUM, 30, 146);
      }),
      gray: mk((c) => {
        c.fillStyle = '#eeeeee'; c.fillRect(0, 0, 660, 260);
        ctrl(c, '#333'); put(c);
      }),
      grad: mk((c) => {
        const g = c.createLinearGradient(0, 0, 0, 260);
        g.addColorStop(0, '#fafafa'); g.addColorStop(1, '#dcdcdc');
        c.fillStyle = g; c.fillRect(0, 0, 660, 260);
        ctrl(c, '#333'); put(c);
      }),
      texture: mk((c) => {
        c.fillStyle = '#f2f0ec'; c.fillRect(0, 0, 660, 260);
        for (let i = 0; i < 9000; i++) {
          const v = 220 + ((i * 37) % 36);
          c.fillStyle = 'rgb(' + v + ',' + v + ',' + (v - 4) + ')';
          c.fillRect((i * 97) % 660, (i * 53) % 260, 2, 2);
        }
        ctrl(c, '#333'); put(c);
      }),
    };
    window.__scenes = {};
    for (const k of Object.keys(scenes)) {
      const blob = await new Promise((r) => scenes[k].toBlob(r, 'image/png'));
      window.__scenes[k] = { url: scenes[k].toDataURL('image/png'), blob };
    }
    return true;
  })()`);

  const names = ['solid', 'dark', 'gray', 'grad', 'texture'];
  for (const k of names) {
    const url = await cdp.evaluate(`window.__scenes['${k}'].url`);
    fs.writeFileSync(path.join(OUT, `${k}_in.png`), Buffer.from(String(url).split(',')[1], 'base64'));
  }

  // 每个场景跑一遍：OCR 框 + toRects 的 pad=2
  const out = await cdp.evaluate(`(async () => {
    const OCR = { x: 31, y: 131, w: 302, h: 17 };
    const PAD2 = { x: 29, y: 129, w: 306, h: 21 };
    const results = [];
    for (const k of ${JSON.stringify(names)}) {
      const sc = window.__scenes[k];
      for (const [tag, r] of [['OCR', OCR], ['PAD2', PAD2]]) {
        const fd = new FormData();
        fd.append('file', new File([sc.blob], k + '.png', { type: 'image/png' }));
        fd.append('rects', JSON.stringify([r]));
        fd.append('method', 'auto');
        const res = await window.WBLocal.handle('/api/text/erase', fd);
        results.push({ key: k + '/' + tag, levels: res.levels, inks: res.inks,
          masks: res.masks, resids: res.resids, methods: res.methods,
          peaks: res.peaks, solids: res.solids, swept: res.swept,
          leftovers: res.leftovers, image: res.image });
      }
    }
    return results;
  })()`);

  for (const r of out) {
    console.log(`\n[${r.key}] method=${JSON.stringify(r.methods)} solid=${JSON.stringify(r.solids)}`
      + ` level=${JSON.stringify(r.levels)} ink=${JSON.stringify(r.inks)}`
      + ` mask=${JSON.stringify(r.masks)}`);
    console.log(`   residual=${JSON.stringify(r.resids)} swept=${JSON.stringify(r.swept)}`
      + ` leftover_max=${JSON.stringify(r.peaks)} peaks=${JSON.stringify(r.peaks)}`
      + ` leftovers=${JSON.stringify(r.leftovers)}`);
    fs.writeFileSync(path.join(OUT, `${r.key.replace('/', '_')}_js.png`),
      Buffer.from(String(r.image).split(',')[1], 'base64'));
  }
  console.log('\n已保存 tools/.dbg-out/ 下的输入图与 JS 输出图');
} catch (e) {
  console.error('测台失败：', e.message);
} finally {
  child.kill();
  if (!fixedProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} }
}
