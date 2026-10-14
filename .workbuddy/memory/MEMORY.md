# WB-PS · 项目长期记忆

## 架构（改渲染行为前必读）

- **两条等价的引擎路径**：浏览器本地 `web/engine/*.js`（部署实际走这条）与
  Python `app/*.py`（本地 dev / 兜底）。改任何渲染语义都要**同时改两边**，
  参数名与默认值必须一致。
- 对应关系：`web/engine/render.js` ↔ `app/text_renderer.py`；
  `web/engine/index.js` ↔ `app/pipeline.py`（`editParams` ↔ `_edit_params`）。
- 前端 `edit` 对象是两条路径的公共契约：UI 放什么字段，两边都要认。
- **例外判据**：只有"渲染语义"变了才需要双端同步。纯前端交互层（如 `web/engine/extract.js`
  的排序/段落合并）与只做上游代理的路由（如 `/api/text/translate`）不属于渲染语义，
  浏览器侧写在 `web/`，Python 侧只补同构路由即可，不要盲目对拍。

## 功能规划（2026-10-13 定案方向）

- 产品定位：**先自己用顺手，顺手留出对外做成产品的口子**。
- 战略判断（已联网核过）：核心资产不是生图，而是「检测 → 识别 → 风格分析 → 原位擦除 →
  原样式重绘」这条**图片文字逆向工程**管线，全在本机 ONNX 跑。新功能沿它外扩，不新开品类。
- 差异化主轴：**本机处理 / 不上传**。市面打码类竞品（DAMA 等）靠这个卖，但只有手机 App，
  Web 端是空位。
- 新功能落地顺序：①截图取文字 + 本机打码（共用同一次检测）→ ②图片翻译·原位换字 →
  ③截图转表格（单独评估，赢在准确率）。
- **架构决策（已被后一步推翻，留档）**：当初定的是新建视图 `#text`「文字工坊」。
  **现在没有 `#text` 视图了** —— 三件事并成「无痕改字」右栏的三个页签
  （改字 / 打码 / 翻译），详见下面「右栏三页签」一节。当时选独立视图的理由
  （三者共用画布与检测结果）依然成立，只是结论改成了"共用同一块右栏画布"。
- 三个功能**前半段共用** `engine/index.js` 的 `detect()`（取文字/打码）或 `analyze()`
  （翻译，要样式）；**后半段**翻译直接复用现有 `applyEdits()`，连溢出处理都靠 `editParams()`
  已有的 `auto_fit` / `font_scale`，不新写排版逻辑。
- 完整方案：`docs/plan-text-workshop.md`。
- 已知硬约束：现装 `ch_PP-OCRv3`（中英），翻译第一期只支持中↔英，多语言识别是独立前置任务；
  打码不得宣称"不可还原"；翻译文本必须出境，UI 要明说。
- **三期都已落地**（取文字 / 打码 / 翻译，现已并成右栏三页签）。翻译的"重绘"完全复用
  `applyEdits()`，**没有新写排版逻辑**，所以按上面的例外判据**不需要双端对拍**：
  浏览器侧在 `web/panels.js` 与 `cloudflare/src/routes/text.js`，Python 侧只补
  `app/text_translate.py` 同构代理。

## 几个别想当然的接口事实

- **`WBShowImages(key)` 里的 images 是视图容器 `viewImages`（装生成 / 作品库），
  不是"改字"**。改字在 `viewEdit` 容器里，要跳回来用 `window.WBEdit.show()`。
  历史上没有"从别的视图跳回改字"的需求，所以只有那一个回喊通道。
- **provider 的 `text_model` 与 `api_key` 语义相反**：`text_model` 传空串是**有效值**
  （= 清空，翻译不可用），后端判 `!= null` / `is not None`；`api_key` 传空串才是"不修改"。
  三处实现（`cloudflare/src/providers.js`、`app/image_gen/config.py`、`web/admin.js`）
  都写了注释，别顺手加 `||` 兜底。
- 文字工坊**只有翻译会联网**，且 `/api/text/translate` 的入参只有 `texts[]`、
  收不到图 —— 这是"图片不出本机"的结构性保证。取文字 / 打码不要为"架构统一"加服务端接口。
- 无头跑 `tools/probe_*.mjs` 时必须自动放行 `confirm()`（probe 顶部已监听
  `Page.javascriptDialogOpening`），否则对话框会把脚本挂死。

## 右栏三页签（原「文字工坊 #text」，2026-10-14 并入）

- **没有 `#text` 视图了**。改字视图 `#viewEdit` 的右栏 `aside.inspector` 是
  「改字 / 打码 / 翻译」三个 `.pane`，共用左侧同一块画布、同一份识别结果。
  侧栏回到三项（改字 / AI 生成 / 作品库）。
- **公共契约就是 `S.edits`**：打码「抹字」= `edits[id]={text:''}`（改字里"留空仅擦除"
  本来就是合法语义），翻译 = `edits[id]={text:译文, auto_fit:true}`。
  **打码与翻译因此一行排版/重绘代码都没有新写**，走的是改字那条预览/导出通路。
  这是整套改造的地基 —— 新加"对识别结果做什么"的功能，先想能不能表达成一批 edits。
- **画布是三层的同尺寸位图**：`imgLayer → maskLayer → boxLayer`（`#scene` 里），
  缩放平移由 `.scene` 的 CSS transform 承担。`sizeLayers()` 一次设三块，
  **别再各处单独设 width/height**。
- **色块 / 马赛克 / 模糊走前端 canvas 直接画**（`drawMasks()`，实时预览）；
  **只有「抹字」走引擎**（`/api/text/erase`）。预览与导出共用同一个绘制函数，
  导出时由 `burnMasks()` 烧进 blob —— **别写第二份绘制代码**。
- 逻辑分文件：右栏两个页签全在 `web/panels.js`（`WBEdit` 是它唯一的口子），
  画布与遮盖层在 `web/app.js`。
- **移除视图时最容易忘的三处**：`web/index.html` 的 NAV 脚本位、`web/shell.js` 的
  `NAV` / `LEGACY`、旧 hash 的兼容表。`LEGACY_PANE` 在 `app.js`，`LEGACY` 在 `shell.js`，
  **两张表要一起改**（一个决定开哪个页签，一个决定侧栏高亮哪一项）。
- 排查这一块的**首选工具是 `tools/probe_edit_panes.mjs`**：打桩 `WBLocal`，
  **不下载模型、几秒一轮、33 项**，本地与线上都能跑（`--base https://ps.ysw69.dpdns.org`
  就是"上线后功能自检"）。
- **状态条显隐会改画布可用高度**（约 44px），所以 `setStatus` 在显隐变化时会主动
  对处于「适应窗口」的缩放实例补算一次。别只依赖 ResizeObserver + rAF ——
  后台标签页 / 无头环境里 rAF 会被节流。
- **`engine/erase.js` 的 `meta.residual` 没有判别力**：它是「内区边缘能量 ÷
  外圈边缘能量」，纯色背景上恒在 100 量级（白底黑字实测也 100+）。要判断"擦干净
  没有"用**区域内灰度标准差**（localapi 的 `leftoverStd`，阈值 8）。
- 打码的规则匹配是纯函数（`engine/mask.js`），**不参与渲染**，所以 Python 侧不需要
  再实现一份（同 `extract.js`，与下面那条「两条等价路径」的例外判据同源）。
  它也不再挂 `window.WBMaskMod` 了（现挂 `window.WBTextEngine`，调试口）——
  用例要它就直接 `import('/static/engine/mask.js')`，别绑内部调试口。

## 浏览器侧引擎的硬约束（踩过大坑）

- **`window.WBLocal` 会被 `engine/boot.js` 整体覆盖**。boot.js 是 module（延迟执行），
  末尾直接 `window.WBLocal = {...}`。所以**在文档创建前预注入桩会被它顶掉** ——
  表现是打桩失效、页面真去下 40MB 模型（脚本挂在「正在识别…」再也不动），
  或者调用计数一会儿有一会儿没有（时序不同，覆盖的先后也不同）。
  正确做法是**锁成访问器属性**，让它的赋值落进空 setter：
  ```js
  Object.defineProperty(window, 'WBLocal', {
    configurable: true, get: () => stub, set: () => {},
  });
  window.requestIdleCallback = () => 0;   // 见下条
  ```
  老做法（页面加载完再注入）只是"后覆盖"侥幸躲开，时序是脆的，别再抄。
- **boot.js 的「空闲预热」绕不过门面**：`requestIdleCallback(() => ensureEngine(...))`
  直接调内部函数，桩拦不住 → 每轮都会注册 SW、读 manifest、拉模型。
  打桩类探针必须把 `requestIdleCallback` 关掉（只有 boot.js 用它，无副作用）。
- **探针里"点了之后隔一会儿再读"要等条件，不要 `sleep` 固定时长**：本地模块命中
  缓存是瞬时的，线上要走真网络 + 面板还有 120ms 去抖 → 同一项本地全绿、线上偶发红。
  判据：本地绿线上红的用例，先怀疑固定 sleep。
- **多通道 Mat 一律 `ptr(row)`，绝不用 `.data` 平铺下标**。`crop`/`clone` 出来的 BGR Mat
  实测 `isContinuous() === false`，但 `data.length` 恰好等于 `rows×cols×channels` ——
  平铺读写**不报错、看着有值、整体错位**。踩到的后果：`fillPatch` 没真刷上、
  `sweepResidue` 没真写、输出图却因为粘贴也用同一套错位读法而**看着干净**，
  只有度量（走 `cvtColor`）如实报残留。判据：**单通道且连续的掩膜可平铺；
  只要是多通道，就必须 `ptr(row)`**。（`cvutil.planeData` 的注释早有警告，但只覆盖了读。）
- 排查引擎算法的**首选工具**是 `tools/dbg_erase_harness.mjs`：直接调
  `/api/text/erase` 跳过 OCR，几秒一轮，产物落 `tools/.dbg-out/`（gitignore）。
  再配 `tools/dbg_diff_js_py.py` 与 Python 同构实现**逐像素对拍**，要求 `maxΔ = 0`。
  比跑全量 `probe_views.mjs`（约 4 分钟）快一个数量级。
- 双端一致性不需要"猜"：dump 出真实输入图 → Python 跑同构实现 → 逐像素对拍即可判定。

## 渲染口径约定

- 描边量以**相对字号的比例**（stroke_rel）保存，字号缩放后等比成立。
- PIL `stroke_width` = 向外扩 N px；canvas 取 `lineWidth = strokePx * 2` 对齐同口径。
  因此**笔画宽度实测变化 ≈ stroke_added 的 2 倍**。
- 自动笔画校准闭环的收敛容差是 0.45px（`/2.0` 换算），做细粒度参数时以此为最小步长基准。
- 人工微调（如 `stroke_bias`）必须**在自动闭环之后**并入 stroke_rel，
  绝不能在 `build()` 里叠加，否则会被闭环当误差补偿掉。

## 环境

- 只有 `~/.workbuddy/binaries/python/envs/default/Scripts/python.exe` 装了 cv2/numpy/PIL，
  跑任何渲染自检 / 脚本都用它（系统 python 与托管 3.13.12 都没有这些包）。

## 工作流约定

- **改 `web/` 只是本地生效**：线上（Cloudflare）跑的是 `cloudflare/public/static/`，
  必须 `cd cloudflare && node scripts/sync-assets.mjs`（= `npm run sync:assets`）同步过去，
  再 `npx wrangler deploy` 才会上线。忘了同步 = 线上看不到改动（踩过一次）。
- 同步脚本会 `rm -rf public` 后重建，所以**不要加 `--no-assets`**：那样会连 39MB 的
  `/assets/` 一起删掉且不补回。全量同步约几秒。
- **同步脚本跑完必须看输出**，正常会有两行统计：「30 个文件，0.50 MB」「9 个文件，39.45 MB」
  （第一行 = `web/` 下的非 assets 文件减去 `README.md` / `engine-test.html` / `sw.js`，
  `sw.js` 单独发到 `public/sw.js`；2026-10-14 文字工坊并进改字后从 31/0.55 变成 30/0.50 ——
  去掉 text.js / text.css、加回 panels.js）。数字随 `web/` 增删文件而变化，
  **关键判据是有没有这两行、以及 `public/static` 存不存在**，别死记文件数。
  它先删 `public/` 再重建，**删成功但重建失败时 `public/static` 会整个不存在**
  （safe-delete shim 偶发失败，重跑一次即好）。只看到报错堆栈 = 没同步成功，
  **此时绝不能接着 deploy**，否则会把空目录传上线。
- 改了 `web/` 下的页面或脚本，顺手把 `web/index.html` 里的 `?v=` 版本号 +0.1：
  `/static/*` 走静态资源层，版本号是防浏览器缓存读到旧脚本的唯一手段（`/assets/*`
  才有 immutable 头，页面脚本没有）。
- **动态 `import()` 必须手动拼上同一个 `?v=`**：它不在 index.html 里，浏览器不会替它
  带版本号，会吃到缓存里的旧模块。普通 `<script src>` 有版本号可依赖，动态 import 没有。
  现在的写法在 `web/panels.js` 顶部：从自己的 `<script src>` 上把 `VER` 读出来，
  再拼给 `engine/extract.js` / `engine/mask.js` —— 保持一个来源，别各写一份。
- 无头跑 `tools/probe_views.mjs` 时传 `--profile <固定目录>` 可复用模型缓存，
  否则每次重新 profile 都要重下 40MB（首次 3~5 分钟，别误判成卡死）。
- 每轮改动结束就 `git commit`；`git push` 之前必须先问用户（见 README 版本管理）。
- **部署**：`cd cloudflare && ./node_modules/.bin/wrangler deploy`。
  `wrangler.toml` 改完**不能只看 "Deployed" 就算成功** —— 必须核对 triggers 里有没有
  `ps.ysw69.dpdns.org (custom domain)` 这一行（没有 = `routes` 未被读到），
  并逐条读 WARNING。踩过：`routes` 写在 `[assets]` 之后被 TOML 当成 `assets.routes`，
  静默失效很久；`routes` 必须放在任何 `[table]` 之前。
- 部署后线上自检：`curl -s "https://ps.ysw69.dpdns.org/static/index.html?cb=$(date +%s)"`
  grep 本次改动的特征符号（沙箱 curl 能通该域名）。
  `/` 应返回 200；`workers.dev` 返回码 000 属预期（已显式关闭）。
  更硬的一招：**直接把 `tools/probe_edit_panes.mjs` 指向线上域名跑**
  （`--base https://ps.ysw69.dpdns.org`）。它打桩了 `WBLocal.handle`，
  不下载模型，7 秒一轮 33 项，等于一个"上线后功能自检"。
- **`/image` 是兼容入口，双端必须同口径**：页面早并入 `/`（靠 hash 切视图）。
  Python 侧在 `app/image_gen/routes.py` 的 `LEGACY_PAGE = {"/image": "#generate"}`。
  **绝不能用 302 实现** —— fragment 不发给服务端，302 会丢锚点（`/image#projects`）；
  必须返回极小 HTML 让浏览器端做 `location.replace("/" + location.hash)`。
- git 只能走 SSH；`gh` CLI 在这台机器上不可用。
- `cloudflare/public/static/`、`cloudflare/public/assets/` 是同步产物，已 gitignore，不要手工改。
  `cloudflare/public/sw.js` **是有意跟踪的**（只有 static/ 与 assets/ 被忽略），改动要提交。
