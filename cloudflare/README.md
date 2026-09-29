# WB-PS · Cloudflare 版

静态前端 + Worker 托管。**Worker 只做两件事**：发静态资源、代理图片生成（key 留在服务端）。

> **这是两个版本之一。** 另一个是**本地版**（`app/`，Python / FastAPI，
> `start.bat` 启动到 `127.0.0.1:8000`）。两者**共用同一份前端源码 `web/`**。
> 项目全貌见上级目录的 [`../README.md`](../README.md)。

- **无痕改字**：全流程在**浏览器本地**跑，服务端完全不参与。
  模型与运行时（约 40MB）作为 `/assets/` 静态资源下发，由 Service Worker
  缓存进用户浏览器，网页直接调用浏览器内缓存的模型推理。
- **图像工坊 + 后台管理**：Node/JS Worker，配置存 KV，key 永不下发前端
- **前端**：`web/` 的页面原样托管（改字与生成已合并进 `index.html`）

> 上一版这里配的是 `HEAVY_BACKEND`：Workers 装不上 OpenCV / ONNX，
> 只能把改字请求反向代理回你自己的 Python 后端，没配就返回 503 降级提示。
> 那套已经**整体删除** —— 现在改字在浏览器里跑，不再需要任何服务端算力。

---

## 改字为什么能搬到浏览器

`wasm-poc/REPORT.md` 验证过：onnxruntime-web + opencv.js 的组合，
识别质量与 Python 原生端等同（简单图逐字一致，真实截图差异来自浮点噪声）。

- **模型**：`rapidocr_onnxruntime` 自带的那三个 onnx，直接复制，两端同源
- **缓存**：Service Worker 拦截 `/assets/` 前缀，命中即返回（实测全量重取 3ms）
- **离线**：缓存写满后断网可用
- **引擎**：`web/engine/` 下按 Python 侧模块逐一对齐（样式反推 / 擦除 / 重绘）

唯一无法完全对齐的是**字体**：浏览器枚举不了系统字体，
只能靠 canvas 指纹探测 + 托管字体（`web/assets/fonts/`）。


---

## 部署（四步）

前置：Node 18+、wrangler（`npm i` 已装到本地）。

### 1. 建 KV 命名空间

```bash
npx wrangler login
npx wrangler kv namespace create WB_PS_KV
```

把返回的 `id` 填进 `wrangler.toml` 里 `[[kv_namespaces]]` 的 `id` 字段，替换掉那个占位字符串。

### 2. 同步前端并设置域名

```bash
npm run sync:assets
```

顺手把 `wrangler.toml` 里的 `FRONTEND_ORIGIN` 改成你自己的域名，别留默认值。

#### ⚠️ 一定要绑自定义域名，`*.workers.dev` 在国内打不开

实测（深圳、普通家宽）：

```
GET https://wb-ps.xxxx.workers.dev/  →  net::ERR_CONNECTION_TIMED_OUT
阿里 DoH 返回 128.242.250.155        →  非 Cloudflare 网段，DNS 已被污染
```

`*.workers.dev` 被 DNS 污染 + 连接超时，**不加代理根本进不去**；换成自持域名
（在 Cloudflare 上的域名，绑成 Worker 的自定义域名）就正常。2026-09-27 这次部署用的是
`ps.ysw69.dpdns.org`。

绑定方式二选一：

- **写进配置（推荐）**：`wrangler.toml` 里声明，后续 `wrangler deploy` 不会覆盖掉

  ```toml
  routes = [
    { pattern = "ps.你的域名", custom_domain = true }
  ]
  ```

- Dashboard → Workers → 你的 Worker → Settings → Domains & Routes → Add → Custom Domain

### 3. 迁移现有账号与配置（可选）

这两个源的 PBKDF2 / HMAC 实现是**字节级兼容**的（`tests/compat.test.mjs` 对着 Python
`hashlib` 生成的基准值做过校验），所以管理密码哈希可以直接搬：

```bash
npm run migrate
npx wrangler kv bulk put --binding=KV kv-bulk.json
rm kv-bulk.json      # 含明文 API key，导完务必删掉
```

迁移后密码不用重设，已发出的会话令牌继续有效。不想迁移就跳过——首次打开后台会让你自己设密码。

> **换运行时的注意点**：Python 版用 **120000 轮** PBKDF2，而 Cloudflare Workers 的
> WebCrypto 硬上限是 **100000 轮**，超了直接抛
> `Pbkdf2 failed: iteration counts above 100000 are not supported` ——
> 线上表现就是后台登录一律 500「服务端内部错误」（这个坑踩过）。
> 因此 Workers 侧的轮数定为 10 万，并**随记录一起存**（`admin.rounds` 字段），校验时按
> 记录里的轮数复算。从 Python 迁过来的旧记录（12 万轮）在 Workers 上算不出来，
> 后台会直接显示"设置密码"表单让你重设，而不是报一个看不懂的"密码不正确"。

### 4. 部署

```bash
npm run deploy
```

打开首页，进 `/admin` 设密码、填中转站，就可以用了。

> 部署后如果想验证线上是否真的可用，跑：
>
> ```bash
> node ../tools/verify_online.mjs --base https://你的域名
> node ../tools/probe_ui.mjs     --base https://你的域名   # 前端交互（含字体导入/导出）
> ```
>
> 两个脚本都用真实 Edge 直连、以 `--no-proxy-server` 启动，所以它们反映的是
> **用户实际会遇到的网络状况**，不是本机 curl 的结果。

---

## 模型资源怎么上线

改字要用的模型与运行时都在 `web/assets/`（约 40MB），同步脚本会一并带到 `public/`：

```bash
npm run sync:assets     # 页面脚本 + sw.js + assets 一次同步
npx wrangler deploy
```

`/assets/` 由静态资源直接服务，Service Worker 负责缓存进浏览器（只下一次）。
本地调试其它模块时可以 `node scripts/sync-assets.mjs --no-assets` 跳过模型 ——
代价是线上改字打不开。

> 部署包会到 40MB 量级。想更轻，可以考虑把 `/assets/` 挪到 R2 或独立 CDN，
> 只需改 `web/modelstore.js` 里的 `base` 与 `sw.js` 的 `MANAGED_PREFIXES`。

---

## 与原 Python 版的差异

刻意保留的行为（保证迁移不突变）：

- 令牌格式同为 `exp.sig` 的 HMAC-SHA256，同样的 `HttpOnly; SameSite=Lax` Cookie
- 错误响应同为 FastAPI 的 `{"detail": {message, hint, detail}}` 形状，前端不用改
- key 一律打码下发；更新时传空串表示「不修改」
- 参照图走 generations 的 `image` 字段；`b64_json` 兼容 data URL 前缀

因运行时限制无法保留：

| 项目 | 原版 | 云端版 |
|---|---|---|
| 会话速率限制 | 进程内存 dict | 挪到 KV（isolate 内存互不相通，否则限速形同虚设） |
| TLS 校验 | 可关闭（`CERT_NONE`） | 不可关，自签证书的中转站会失败 |
| HTTP 代理 | 支持 `provider.proxy` | 不支持，该字段被忽略 |
| 改字算力 | 服务端 OpenCV + ONNX | **浏览器本地 WASM**，模型缓存在用户浏览器 |
| 口令哈希轮数 | PBKDF2 120000 轮 | **100000 轮**（Workers 硬上限），轮数随记录存 |
| 生成超时 | 无（本地无边缘限制） | 受 `MAX_UPSTREAM_TIMEOUT` 限制，见下 |
| 字体来源 | 扫系统目录 + `fonts/` | 托管字体 + 指纹探测 + **浏览器侧导入/本机字体扫描** |
| 注销登录 | 删 Cookie | 相同。令牌有效期内仍可用，与原版一致 |

### 出图超时：为什么用流式，以及为什么能等到分钟级

先说结论：**改成流式（心跳保活）之后，慢的中转站也能等完。**

Cloudflare 边缘对**没有数据流动**超过约 100 秒的响应会断开，表现为 524。注意关键词是
"没有数据流动"——不是"总时长的上限"。实测验证过：一个持续 151 秒、每 10 秒吐一行心跳的
流式响应能完整送达（`deploy` 后可直接核对这一点）。

所以生成接口提供两种模式：

| 模式 | 上限配置 | 说明 |
|---|---|---|
| **流式**（前端默认） | `MAX_STREAM_TIMEOUT`，默认 **300s** | 服务端每 5 秒吐一行 NDJSON 心跳，连接保持活跃，不受 100s 空闲限制 |
| 一次性 | `MAX_UPSTREAM_TIMEOUT`，默认 **90s** | 老式"等完整 JSON"，受边缘 100s 空闲上限约束 |

协议（NDJSON，一行一个 JSON）：

```
{"type":"start","timeout":300,"elapsed":0}
{"type":"tick","elapsed":5}          ← 每 5 秒一行，保活 + 给界面报进度
{"type":"tick","elapsed":10}
{"type":"done","ok":true,"images":[...]}      或  {"type":"error","error":{message,hint,detail}}
```

两个必须知道的点：

- **错误也走流内**（`{"type":"error"}`），HTTP 状态自始至终是 200 —— 因为响应头在建流时
  就发出去了。客户端要读流才知道成败，别只看 `response.ok`。
- 客户端断开时（关页面 / 点取消），`ReadableStream.cancel()` 会把上游请求一起 abort，
  不会让任务白跑完再丢。

历史数据（供参考）：实测一次 1024×1024、1 张的生成 **57.7s**，慢的提示词会超过 90s ——
这正是当初 60s 上限"有时成有时败"的原因。

真遇到中转站慢过 `MAX_STREAM_TIMEOUT`，只能从**减少单次工作量**入手（降张数/降尺寸）
或换中转站；这是平台边界，不是配置问题。

---

## 本地开发

```bash
npm run dev      # 本地起 Worker
npm run test     # 兼容性 + 端到端测试
npm run build    # 验证构建产物
```

`npm run test` 会先跑 `compat.test.mjs`（对着 Python 生成的基准值校验 PBKDF2/HMAC 是否一致），
再跑 `e2e.test.mjs`（用真实 Request/Response 打进 Worker，覆盖鉴权、CRUD、生成、降级四条链路）。

> 测试踩到过一个坑：`wrangler 3.x` 会把 `[assets]` 静默丢掉，构建产物里没有 HTML/CSS/JS，
> 部署后必然满屏 404。本项目锁 `wrangler@4.140+`。
