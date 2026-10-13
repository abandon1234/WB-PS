/* ==========================================================================
   WB-PS · 文字提取（纯函数层）

   把 detect() 吐出来的 items（一坨无序的文字框）变成「人能读的文本」：
     排序 → 分行 → 分段落 → 导出 txt / md

   为什么单独一个文件、还放在引擎目录：
   这里的逻辑没有 DOM、没有 OpenCV、没有 OCR，输入是 items、输出是字符串，
   是**纯函数** —— 所以能单独测、能单独改，改它不会碰到任何像素口径。

   ⚠️ 与「两条等价路径」约定的关系：
   项目约定「改渲染语义要同步改 web/engine/* 与 app/*」，但**本文件不参与渲染**，
   不涉及任何像素/字体/描边口径，所以 Python 侧不需要再实现一份。
   那条约定只管渲染（web/engine/render.js ↔ app/text_renderer.py）。
   ========================================================================== */

/** 中位数；空数组返回 0（调用方据此走兜底分支） */
function median(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const cyOf = (r) => r.y + r.h / 2;
const ASCII_WORD = /[0-9A-Za-z]/;

/** 句末标点：以它结尾的行多半是「一句话说完了」，不该和下一行并成一段 */
const END_PUNCT = /[。．.!！?？；;：:”"』」】]$/;

/** 列表项前缀（-、·、•、1.、1、、(1) …），用于判断段落要不要保留换行 */
const LIST_HEAD = /^\s*(?:[-·•*–—]|\d{1,2}\s*[.、)）]|[（(]\s*\d{1,2}\s*[)）])\s*/;

/**
 * 片段拼接：两侧都是 ASCII 词字符时补一个空格，其余（中文之间）直接相连。
 * 比 mergeLines 里「整行是否纯 ASCII」的粗判更贴事实 ——
 * 「序列号 SN-2026」这种中英混排，一行里两种规则都要用得上。
 *
 * 有 gaps / lineH 时还多一条：**两片贴得极近就不加空格**。
 * 「SN-2026-0918-A7」被 OCR 切成几段时，按纯文本规则会插出一串空格，
 * 而它们的框明明挨在一起 —— 距离比字符类型更能说明"这本来是一个词"。
 */
function joinSegments(texts, { gaps = null, lineH = 0 } = {}) {
  let out = '';
  const arr = texts || [];
  for (let i = 0; i < arr.length; i++) {
    const t = String(arr[i] == null ? '' : arr[i]).trim();
    if (!t) continue;
    if (!out) { out = t; continue; }
    const a = out[out.length - 1], b = t[0];
    const gap = gaps ? gaps[i] : Infinity;
    const tight = lineH > 0 && gap <= lineH * 0.34;
    out += (!tight && ASCII_WORD.test(a) && ASCII_WORD.test(b)) ? ' ' + t : t;
  }
  return out;
}

/**
 * 分行 + 排序。
 *
 * 1. 按框中心 y 升序（同一 y 再按 x）—— 得到一个「从上到下」的粗糙顺序
 * 2. 与当前行中心差 ≤ 行高中位数 × lineTol 的归为同一行
 * 3. 行内按 x 升序（左到右）
 *
 * 注意：detect() 的 mergeLines 已经把「同一行被 OCR 切碎的片段」合并过了，
 * 这里再分行是**第二次兜底** —— 容差比它略宽（0.6 vs 0.45），用于兜住
 * 它没合上的情况（跨列、字号差异大的混排）。
 */
export function buildLines(items, { lineTol = 0.6 } = {}) {
  const list = (items || []).filter((it) => it && it.rect && String(it.text || '').trim());
  if (!list.length) return [];

  const medH = Math.max(median(list.map((it) => it.rect.h)), 1);
  const tol = Math.max(medH * lineTol, 2);

  const byY = [...list].sort(
    (a, b) => (cyOf(a.rect) - cyOf(b.rect)) || (a.rect.x - b.rect.x));

  const rows = [];
  for (const it of byY) {
    const last = rows[rows.length - 1];
    // 高度量级差太多的不要并（大标题 + 紧邻的小字，是两行不是一行）
    const hOk = !last || (it.rect.h / Math.max(last.h, 1) <= 2.6);
    if (last && hOk && Math.abs(cyOf(it.rect) - last.cy) <= tol) {
      last.items.push(it);
      last.cy = last.items.reduce((s, x) => s + cyOf(x.rect), 0) / last.items.length;
      last.h = Math.max(last.h, it.rect.h);
    } else {
      rows.push({ items: [it], cy: cyOf(it.rect), h: it.rect.h });
    }
  }

  return rows.map((row, i) => {
    const its = [...row.items].sort((a, b) => a.rect.x - b.rect.x);
    const x0 = Math.min(...its.map((it) => it.rect.x));
    const y0 = Math.min(...its.map((it) => it.rect.y));
    const x1 = Math.max(...its.map((it) => it.rect.x + it.rect.w));
    const y1 = Math.max(...its.map((it) => it.rect.y + it.rect.h));
    const h = Math.max(y1 - y0, 1);
    const gaps = its.map((it, k) => (k === 0
      ? 0
      : Math.max(0, it.rect.x - (its[k - 1].rect.x + its[k - 1].rect.w))));
    return {
      id: i,
      ids: its.map((it) => it.id),
      items: its,
      text: joinSegments(its.map((it) => it.text), { gaps, lineH: h }),
      rect: { x: x0, y: y0, w: Math.max(x1 - x0, 1), h },
      cy: (y0 + y1) / 2,
      h,
      angle: its.reduce((s, it) => s + (it.angle || 0), 0) / its.length,
      axis: its.every((it) => it.quad_axis !== false),
    };
  });
}

/**
 * 段落合并：把「属于同一段的多行」合成一组。
 *
 * 相邻两行同时满足才并：
 *   · 左边界接近（差值 < 行高中位数 × leftTol）—— 段内各行通常对齐，
 *     分段时首行缩进、列表项缩进都会让左边界明显错开
 *   · 行距正常（在 [-0.6, gapTol] 倍行高之间）—— 段间距通常明显大于行距
 *   · 两行字号相当（行高比 ≥ hRatio）—— 段内字号一致，标题与正文差得明显
 *   · 上一行末尾不是句末标点
 */
export function groupParagraphs(lines, { leftTol = 0.5, gapTol = 1.6, hRatio = 0.62, baseH = 0 } = {}) {
  if (!lines || !lines.length) return [];
  const medH = baseH > 0 ? baseH : Math.max(median(lines.map((l) => l.h)), 1);

  const paras = [];
  let cur = null;
  for (const ln of lines) {
    if (!cur) { cur = [ln]; paras.push(cur); continue; }
    const prev = cur[cur.length - 1];
    const gap = ln.rect.y - (prev.rect.y + prev.rect.h);
    const leftOk = Math.abs(ln.rect.x - prev.rect.x) < medH * leftTol;
    const gapOk = gap > -medH * 0.6 && gap < medH * gapTol;
    const hOk = Math.min(ln.h, prev.h) / Math.max(ln.h, prev.h, 1) >= hRatio;
    const noEnd = !END_PUNCT.test(prev.text);
    if (leftOk && gapOk && hOk && noEnd) cur.push(ln);
    else { cur = [ln]; paras.push(cur); }
  }
  return paras;
}

/** 纯文本：段落之间空一行，段内保留换行（行结构对「逐行核对」有用） */
export function toPlainText(paras) {
  return (paras || []).map((p) => p.map((l) => l.text).join('\n')).join('\n\n');
}

/**
 * Markdown：段内多行合成一行（OCR 的换行是排版换行，不是语义换行），
 * 并按行高推断标题层级 —— 扫书/扫资料时这比一堆平铺的句子实用得多。
 *
 * 用行高而不是 style.font_size：取文字只走 detect()，不跑样式分析，
 * 没有 font_size 可用；行高与字号在同一行里是等比关系，替代是等价的。
 * 阈值取全图中位行高：≥1.4 倍 → ##（大标题），≥1.2 倍 → ###（小标题）。
 */
export function toMarkdown(paras, { baseH = 0 } = {}) {
  if (!paras || !paras.length) return '';
  const medH = baseH > 0
    ? baseH
    : Math.max(median(paras.flat().map((l) => l.h)), 1);

  const blocks = paras.map((p) => {
    const ratio = medH > 0 ? p[0].h / medH : 1;
    // 整段都像列表项时保留逐行（拼成一行会把列表毁掉）
    const isList = p.length > 1 && p.every((l) => LIST_HEAD.test(l.text));
    const body = (p.length > 1 && !isList)
      ? joinSegments(p.map((l) => l.text))
      : p.map((l) => l.text).join('\n');
    if (ratio >= 1.4) return `## ${body}`;
    if (ratio >= 1.2) return `### ${body}`;
    return body;
  });

  return blocks.join('\n\n') + '\n';
}

/**
 * 一站式：items → 行 / 段落 / 文本 / Markdown。
 *
 * baseH（中位行高）同时喂给分段与标题推断 —— 两处用同一个基准，
 * 免得出现「分了段但没标题」「按 A 分段、按 B 判标题」这种对不上的情况。
 */
export function extract(items, opts = {}) {
  const lines = buildLines(items, opts);
  const baseH = Math.max(median(lines.map((l) => l.h)), 1);
  const paragraphs = groupParagraphs(lines, { ...opts, baseH });
  return {
    lines,
    paragraphs,
    baseH,
    text: toPlainText(paragraphs),
    markdown: toMarkdown(paragraphs, { baseH }),
    count: lines.length,
    paraCount: paragraphs.length,
    // 竖排 / 明显倾斜的图，第一版不做重排：照原样给出并让调用方标注
    tilted: lines.some((l) => Math.abs(l.angle) > 5 || !l.axis),
  };
}

export { median, joinSegments };
