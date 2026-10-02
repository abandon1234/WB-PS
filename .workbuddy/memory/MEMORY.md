# WB-PS · 项目长期记忆

## 架构（改渲染行为前必读）

- **两条等价的引擎路径**：浏览器本地 `web/engine/*.js`（部署实际走这条）与
  Python `app/*.py`（本地 dev / 兜底）。改任何渲染语义都要**同时改两边**，
  参数名与默认值必须一致。
- 对应关系：`web/engine/render.js` ↔ `app/text_renderer.py`；
  `web/engine/index.js` ↔ `app/pipeline.py`（`editParams` ↔ `_edit_params`）。
- 前端 `edit` 对象是两条路径的公共契约：UI 放什么字段，两边都要认。

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
- 改了 `web/` 下的页面或脚本，顺手把 `web/index.html` 里的 `?v=` 版本号 +0.1：
  `/static/*` 走静态资源层，版本号是防浏览器缓存读到旧脚本的唯一手段（`/assets/*`
  才有 immutable 头，页面脚本没有）。
- 每轮改动结束就 `git commit`；`git push` 之前必须先问用户（见 README 版本管理）。
- git 只能走 SSH；`gh` CLI 在这台机器上不可用。
- `cloudflare/public/` 是同步产物，已 gitignore，不要手工改。
