# web/ · 前端源码（两个版本共用）

这里的项目源码被**两个版本同时使用**：

| 版本 | 后端 | 怎么用这份前端 |
|---|---|---|
| 本地版 | `../app/`（Python / FastAPI） | 直接托管本目录 |
| Cloudflare 版 | `../cloudflare/src/`（Workers） | 同步到 `cloudflare/public/static/` |

**所以改这里 = 两个版本一起改。** 改完如果是 Cloudflare 版，记得跑一次同步：

```bash
cd ../cloudflare && npm run sync:assets
```

## 目录里的主要文件

- `index.html` —— **主页面**：无痕改字（`#viewEdit`）+ 图像生成（`#viewImages`），
  两者是同一个页面里的两个视图，靠 hash 切换，不再跨页跳转
- `app.js` —— 改字模块 + 视图路由
- `image.js` —— 生成模块（可独立成页，也可嵌进主页面）
- `shell.css/.js` —— 共享外壳：设计令牌、侧栏、折叠、图标雪碧图
- `engine/` —— 浏览器端推理引擎（WASM）
- `sw.js` —— Service Worker，缓存 `/assets/`（约 40MB 模型）

## 改动后要做的两件事

1. **推进 `?v=` 版本号**：`index.html` 引用脚本带 `?v=3.4` 这类后缀，
   改了 JS/CSS 要同步推进，否则回访用户拿到旧文件。
2. **跑一遍验证**：`node ../tools/probe_views.mjs --base <地址>` 等，见 `../README.md`。
