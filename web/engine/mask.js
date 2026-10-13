/* ==========================================================================
   WB-PS · 敏感信息识别（纯函数层）

   在「已经识别出来的文字框」上再叠一层规则匹配：手机号、身份证、银行卡、
   邮箱、车牌…… 输出一张**待遮盖清单**（位置 + 类型 + 命中的原文），
   交给前端画遮盖。本文件不碰像素、不碰 DOM、不碰 OCR。

   为什么要单独一个文件、还放在引擎目录：
   和 extract.js 同样的理由 —— 输入是 items/lines、输出是纯数据，能单独测、
   能单独改。改规则就像改配置，不该顺手碰到渲染代码。

   ⚠️ 与「两条等价路径」约定的关系：
   本文件不参与渲染（不涉及字体 / 描边 / 像素口径），所以 Python 侧不需要
   再实现一份。那条约定只管渲染（web/engine/render.js ↔ app/text_renderer.py）。

   ---------------------------------------------------------------------------
   两条设计原则（都是被误伤率逼出来的）：

   1. **能落到单个文字框就绝不整行盖。**
      「电话 13800138000」如果 OCR 给的是一个框，那只能盖整框（盖掉"电话"两字
      也算可接受）；但如果是「电话」+「13800138000」两个框，就只盖号码。
      逐框匹配优先，整行匹配只作为兜底 —— 兜住"号码被 OCR 切成两半"的情况。

   2. **兜底规则（长数字串）必须整框命中。**
      否则「订单号 202610131234567」里的 11 位数字、"1920×1080" 这类尺寸
      会被一起打掉。宁可漏，不可误伤 —— 漏了用户还能手动框选补，
      误伤了用户往往到发出去才发现。
   ========================================================================== */

/**
 * 规则表。**数组顺序 = 优先级**：先匹配的占用字符区间，后面的规则跳过与它
 * 重叠的部分。顺序不敏感的话，18 位身份证会同时满足「16~19 位数字」，
 * 被标成"银行卡"。
 *
 * 字段：
 *   id       规则键，前端按它记忆开关状态
 *   label    展示名（命中清单里的徽标文案）
 *   re       正则（源码，内部会补 /g）
 *   digits   命中两侧不能挨着数字 —— 从 19 位卡号里截出 18 位这种情况要靠它挡住
 *   full     必须整框命中才算（兜底规则用）
 *   validate 额外校验（IPv4 每段 ≤255 这类）
 */
export const RULES = [
  { id: 'email',  label: '邮箱',     re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/ },
  {
    id: 'plate', label: '车牌',
    // 省份简称 + 字母 + 5~6 位（含新能源），末位可为"挂/学/警/港/澳"
    re: /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]/,
  },
  {
    id: 'ipv4', label: 'IP 地址',
    re: /\d{1,3}(?:\.\d{1,3}){3}/,
    digits: true,
    validate: (s) => s.split('.').every((n) => Number(n) <= 255),
  },
  { id: 'idcard', label: '身份证',   re: /\d{17}[\dXx]/, digits: true },
  { id: 'bank',   label: '银行卡',   re: /\d{16,19}/,    digits: true },
  { id: 'phone',  label: '手机号',   re: /1[3-9]\d{9}/,  digits: true },
  { id: 'tel',    label: '固话',     re: /0\d{2,3}[-\s]?\d{7,8}/, digits: true },
  // 兜底：够长就盖。**必须整框** —— 见文件头第 2 条原则。
  // yieldTo：若这段文字本可以被某条"具体数字规则"命中（说明那条规则被用户
  // 关掉了，否则它早就先命中并占位了），兜底要让路 —— 不然「关掉手机号」
  // 这个开关按下去没有任何效果，11 位数字照样被兜底打掉，用户会以为坏了。
  {
    id: 'longnum', label: '长数字串', re: /\d{11,}/, digits: true, full: true,
    yieldTo: ['phone', 'idcard', 'bank', 'tel'],
  },
];

/** 默认全开（用户能在界面上逐条关掉） */
export function defaultRuleState() {
  const o = {};
  for (const r of RULES) o[r.id] = true;
  return o;
}

/* ---------------------------------------------------------------- 匹配 */

/** 命中两侧不能挨着数字（否则是长数字串的一截，不是独立号码） */
function bounded(text, s, e) {
  const before = s > 0 ? text[s - 1] : '';
  const after = e < text.length ? text[e] : '';
  return !/\d/.test(before) && !/\d/.test(after);
}

/** 命中是否占满整段文字（允许两侧空白） */
function isWhole(text, s, e) {
  return !text.slice(0, s).trim() && !text.slice(e).trim();
}

/**
 * 在 text 里找一条规则的所有命中。
 *
 * 不用 lookbehind（(?<!\d)）：Safari 16.4 以前不支持，而那是**正则字面量的
 * 语法错误** —— 整个脚本会挂掉，不是"这条规则不生效"这么轻。所以边界改成
 * 匹配后手工判断，兼容性最好，逻辑也更显眼。
 */
function scanText(text, rule) {
  const hits = [];
  const src = String(text == null ? '' : text);
  if (!src) return hits;
  const rx = new RegExp(rule.re.source, rule.re.flags.includes('g')
    ? rule.re.flags : rule.re.flags + 'g');
  let m;
  while ((m = rx.exec(src)) !== null) {
    if (!m[0]) { rx.lastIndex++; continue; }        // 防空串死循环
    const s = m.index;
    const e = s + m[0].length;
    if (rule.digits && !bounded(src, s, e)) continue;
    if (rule.validate && !rule.validate(m[0])) continue;
    if (rule.full && !isWhole(src, s, e)) continue;
    hits.push({ start: s, end: e, text: m[0] });
  }
  return hits;
}

const overlap = (occ, h) => occ.some((o) => h.start < o.end && o.start < h.end);

/**
 * 逐框匹配：同一段字符只算一次，按 RULES 的顺序决定归哪一类。
 * occ 是已占用区间，调用方传进来是为了让「逐框」与「整行」两轮之间
 * 也能共享占用状态（虽然目前两轮是互斥的，留着更稳）。
 */
function matchOne(text, rules, occ, allRules = RULES) {
  const out = [];
  for (const r of rules) {
    for (const h of scanText(text, r)) {
      if (overlap(occ, h)) continue;
      if (r.yieldTo && coveredBy(text, h, r.yieldTo, allRules)) continue;   // 兜底让路
      occ.push(h);
      out.push({ rule: r, text: h.text });
    }
  }
  return out;
}

/** 命中的这一段是否本可以被某条被关掉的具体规则完整命中 */
function coveredBy(text, hit, ids, allRules) {
  return ids.some((id) => {
    const r = allRules.find((x) => x.id === id);
    if (!r) return false;
    return scanText(text, r).some((x) => x.start <= hit.start && x.end >= hit.end);
  });
}

/**
 * 主入口：lines（engine/extract.js 的 buildLines 产物）→ 待遮盖清单。
 *
 * 返回项：
 *   { id, ruleId, label, text, rect, lineId, scope }
 *   scope = 'item'（精确到某个文字框）| 'line'（整行兜底）
 *
 * enabled 传 { [ruleId]: false } 可关掉单条规则；不传 = 全开但不含 false 的项。
 */
export function findSensitive(lines, { rules = RULES, enabled = null } = {}) {
  const on = (r) => !enabled || enabled[r.id] !== false;
  const out = [];
  let seq = 0;

  for (const ln of lines || []) {
    if (!ln || !ln.rect) continue;
    const occ = [];
    const local = [];

    // ① 逐框：能精确到具体文字框就不整行盖
    for (const it of ln.items || []) {
      const its = matchOne(it.text, rules.filter(on), occ, rules);
      for (const h of its) local.push({ ...h, rect: it.rect, scope: 'item' });
    }

    // ② 整行兜底：只有在"整行拼起来才凑得出号码"时才用（号码被 OCR 切碎）
    if (!local.length && ln.text) {
      const locc = [];
      for (const h of matchOne(ln.text, rules.filter(on), locc, rules)) {
        local.push({ ...h, rect: ln.rect, scope: 'line' });
      }
    }

    for (const h of local) {
      out.push({
        id: `m${seq++}`,
        ruleId: h.rule.id,
        label: h.rule.label,
        text: h.text,
        rect: { x: h.rect.x, y: h.rect.y, w: h.rect.w, h: h.rect.h },
        lineId: ln.id,
        scope: h.scope,
      });
    }
  }

  return out;
}

/** 按类型计数（界面上的「手机号 × 2」这类提示） */
export function summarize(hits) {
  const by = {};
  for (const h of hits || []) by[h.ruleId] = (by[h.ruleId] || 0) + 1;
  return {
    total: (hits || []).length,
    by,
    labels: (hits || []).reduce((acc, h) => {
      if (!acc[h.ruleId]) acc[h.ruleId] = h.label;
      return acc;
    }, {}),
  };
}

/**
 * 把「待遮盖项」摊成可以交给 canvas 的矩形列表。
 *
 * 为什么还要过一道：同一个文字框可能被两条规则各命中一部分（虽然 RULES 的
 * 占用机制已经挡了大部分），重叠矩形分开画会让半透明色块叠出深色块；
 * 合并成互不重叠的矩形后视觉才干净。
 *
 * pad 是向外扩的像素：OCR 的框常常刚好贴着字形，不扩的话文字边缘会露出
 * 一圈"描边"（尤其是 JPEG 有压缩伪影时）。
 */
export function toRects(hits, { pad = 2 } = {}) {
  const on = (hits || []).filter((h) => h && h.rect && h.on !== false);
  const merged = [];
  for (const h of on) {
    const r = {
      x: Math.max(0, h.rect.x - pad),
      y: Math.max(0, h.rect.y - pad),
      w: Math.max(1, h.rect.w + pad * 2),
      h: Math.max(1, h.rect.h + pad * 2),
    };
    // 与已有矩形有交叠就并进去（迭代到稳定，避免连环重叠漏并）
    let mergedIn = false;
    for (const m of merged) {
      if (r.x < m.x + m.w && m.x < r.x + r.w && r.y < m.y + m.h && m.y < r.y + r.h) {
        const x0 = Math.min(m.x, r.x), y0 = Math.min(m.y, r.y);
        const x1 = Math.max(m.x + m.w, r.x + r.w), y1 = Math.max(m.y + m.h, r.y + r.h);
        m.x = x0; m.y = y0; m.w = x1 - x0; m.h = y1 - y0;
        mergedIn = true;
        break;
      }
    }
    if (!mergedIn) merged.push(r);
  }
  return merged;
}
