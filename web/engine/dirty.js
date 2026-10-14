/* ==========================================================================
   「这次编辑到底要不要动图」 —— 唯一实现

   为什么单独一个文件：这个判断以前在两边各写了一份，而且**口径不同**：

     引擎（applyEdits）   : 必须真的和原文/原样式不同才算改动
     UI（app.js 的编辑面板）: 只要字段被设过就算改动

   后果不是"多一次或少一次重绘"这么轻。UI 一旦判"改了"，就会立刻贴本地预览补丁；
   而预览补丁的擦除范围是按 `rect` 外扩（`pad = clamp(h*0.9, 8, 48)`）算的，
   **框外的东西会被一起擦掉**。于是出现这种错位：

     · 预览：擦掉 rect 外扩区 → 连 OCR 没识别出来的框外字符一起抹掉，再重绘识别到的文字
     · 结果：引擎判「没改」→ 根本不擦不画 → 结果图就是原图（框外那个字符还在）

   实测踩到过一次：原图是「聚缘快捷宾馆1」，OCR 只识别出「聚缘快捷宾馆」，
   用户点了一下与现状等价的样式 → 界面显示 6 字、结果图 7 字，被当成"渲染错了"。

   所以：**UI 与引擎必须共用这一份判断**。改动本文件 = 改动渲染语义。
   Python 侧的对应实现是 `app/pipeline.py` 的 `_dirty`，改这里要同时核一遍那边。
   ========================================================================== */

/**
 * 判断该编辑是否真的需要动图（避免无意义的擦除重绘）。
 *
 * @param {object} edit 用户在某一项上的改动（{text, family, bold, align…}）
 * @param {object} item 引擎识别出来的原始项（{text, style:{…}}）
 * @returns {boolean}
 */
export function isDirty(edit, item) {
  // 显式关闭的项直接跳过，连擦除都不做
  if (edit.enabled === false) return false;
  if (!item) return false;

  const newText = edit.text;
  if (newText !== undefined && newText !== null &&
      String(newText) !== String(item.text || '')) return true;
  if (edit.force) return true;

  const style = item.style || {};
  const checks = [
    ['family', null], ['font_size', null], ['font_scale', 1.0],
    ['fg_color', style.fg_color], ['bold', style.bold], ['align', style.align],
    ['valign', 'bottom'], ['erase_method', 'auto'],
  ];
  for (const [key, def] of checks) {
    if (!(key in edit)) continue;
    const v = edit[key];
    if (v === null || v === '' || v === undefined) continue;
    if (key === 'fg_color' && Array.isArray(v) && Array.isArray(def) && v.join() === def.join()) continue;
    if (v === def) continue;
    return true;
  }
  for (const key of ['italic', 'offset_x', 'offset_y', 'letter_spacing', 'weight_bias']) {
    const v = edit[key];
    if (v !== null && v !== undefined && v !== 0 && v !== false) return true;
  }
  const switches = { auto_fit: false, match_sharpness: true, auto_family: true, match_stroke: true };
  for (const [key, def] of Object.entries(switches)) {
    if (key in edit && !!edit[key] !== def) return true;
  }
  return false;
}
