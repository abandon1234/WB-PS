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
- **架构决策**：新建视图 `#text`「文字工坊」（NAV 一项，内含 取文字/打码/翻译 三模式），
  **不要**把这三件事塞进「无痕改字」视图。理由：三者共用画布与检测结果；改字的 inspector
  是重度样式编辑器，混进来会互相干扰。协作关系是「工坊批量 → 改字精修」。
- 三个功能**前半段共用** `engine/index.js` 的 `detect()`（取文字/打码）或 `analyze()`
  （翻译，要样式）；**后半段**翻译直接复用现有 `applyEdits()`，连溢出处理都靠 `editParams()`
  已有的 `auto_fit` / `font_scale`，不新写排版逻辑。
- 完整方案：`docs/plan-text-workshop.md`。
- 已知硬约束：现装 `ch_PP-OCRv3`（中英），翻译第一期只支持中↔英，多语言识别是独立前置任务；
  打码不得宣称"不可还原"；翻译文本必须出境，UI 要明说。
- **三期都已落地**（取文字 / 打码 / 翻译）。翻译的"重绘"完全复用 `applyEdits()`，
  **没有新写排版逻辑**，所以按上面的例外判据**不需要双端对拍**：浏览器侧在 `web/text.js`
  与 `cloudflare/src/routes/text.js`，Python 侧只补 `app/text_translate.py` 同构代理。

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

## 文字工坊（#text）约定

- 三个模式**共用一次检测**：`text.js` 的 `detectOnce()` 按「文件名+大小+修改时间」
  签名缓存，同一张图切模式不重跑。别在模式里各自调 `runDetect`。
- 缩放语义只有一份：`createZoom()` 工厂（实例注册进 `ZOOMS`）。取文字与打码的
  面板 id 前缀不同（`copy*` / `mask*`），行为必须一致，改一处即改两处。
- **状态条显隐会改画布可用高度**（约 44px），所以 `setStatus` 在显隐变化时会主动
  对处于「适应窗口」的缩放实例补算一次。别只依赖 ResizeObserver + rAF ——
  后台标签页 / 无头环境里 rAF 会被节流。新增带状态条的面板要沿用 `setStatus`。
- **`engine/erase.js` 的 `meta.residual` 没有判别力**：它是「内区边缘能量 ÷
  外圈边缘能量」，纯色背景上恒在 100 量级（白底黑字实测也 100+）。要判断"擦干净
  没有"用**区域内灰度标准差**（localapi 的 `leftoverStd`，阈值 8）。
- 打码的规则匹配是纯函数（`engine/mask.js`），**不参与渲染**，所以 Python 侧不需要
  再实现一份（同 `extract.js`，与下面那条「两条等价路径」的例外判据同源）。
- 打码的遮盖：色块 / 马赛克 / 模糊是**前端 canvas 直接画**（实时预览，不走引擎）；
  只有「抹字」走引擎。预览与导出共用 `drawMasks()`，别写第二份绘制代码。

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
- **同步脚本跑完必须看输出**，正常会有两行统计：「30 个文件，0.46 MB」「9 个文件，39.45 MB」。
  它先删 `public/` 再重建，**删成功但重建失败时 `public/static` 会整个不存在**
  （safe-delete shim 偶发失败，重跑一次即好）。只看到报错堆栈 = 没同步成功，
  **此时绝不能接着 deploy**，否则会把空目录传上线。
- 改了 `web/` 下的页面或脚本，顺手把 `web/index.html` 里的 `?v=` 版本号 +0.1：
  `/static/*` 走静态资源层，版本号是防浏览器缓存读到旧脚本的唯一手段（`/assets/*`
  才有 immutable 头，页面脚本没有）。
- **动态 `import()` 必须手动拼上同一个 `?v=`**：它不在 index.html 里，
  浏览器不会替它带版本号，会吃到缓存里的旧模块（踩点：`web/text.js` 里取
  `engine/extract.js`）。普通 `<script src>` 有版本号可依赖，动态 import 没有。
- **动态 `import()` 的模块（如 `web/engine/extract.js`）要自己拼上当前 `?v=`**：
  它不在 index.html 里，不会被版本号带上，不手动拼就会被浏览器吃旧脚本
  （`web/text.js` 里的 `VER` 就是这么来的）。
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
- git 只能走 SSH；`gh` CLI 在这台机器上不可用。
- `cloudflare/public/static/`、`cloudflare/public/assets/` 是同步产物，已 gitignore，不要手工改。
