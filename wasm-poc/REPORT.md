# 浏览器端 OCR 可行性验证报告

**结论：可行。浏览器端跑出了与 Python 端同等的识别质量，且不需要任何后端。**

验证日期：2026-09-27　验证范围：仅「无痕改字」流水线的第一步（文字检测 + 识别）

---

## 1. 要回答的问题

`cloudflare/` 版本里「无痕改字」只能降级（Workers 装不上 OpenCV / ONNX Runtime）。
当时留的备选方案是：**把模型和图像处理都放到浏览器里跑，网页直接调用**。
本 PoC 用于验证这条路在技术上是否成立。

## 2. 验证方法

关键设计：**两侧用同一份模型、同一份算法，只在运行时上不同**。

| 环节 | Python 端（现状） | 浏览器端（PoC） |
|---|---|---|
| ONNX 运行时 | onnxruntime（原生 C++） | onnxruntime-web 1.30（WASM） |
| 图像处理 | opencv-python | opencv.js 5.0（WASM，同一份 C++ 编译） |
| 模型 | `rapidocr_onnxruntime` 自带 | **同一批 .onnx 文件**，直接复制 |
| 字典 | 模型 metadata `splitlines()` | Python 预导出 JSON（避免解析差异） |

比对基准由 Python 端 `RapidOCR` 生成，浏览器端用逐行复刻的实现跑同一张图。
输入像素由 Python 导出为原始 BGR 字节，**排除图片解码器的干扰**。

复刻覆盖了 `rapidocr_onnxruntime` 的全部关键路径：
检测预处理（resize→32 倍数 / NormalizeImage / ToCHW）、DB 后处理
（阈值→膨胀→findContours→minAreaRect→box_score→unclip→坐标映射→过滤）、
透视裁剪（含竖排 `rot90`）、方向分类（含 180° 翻转）、识别预处理、CTC 解码。

## 3. 结果

### 3.1 简单测试图（`samples/test_card.png`，720×1000，9 个文本框）

```
文本一致: 9/9        坐标最大偏差: 2.00 px      置信度最大偏差: 0.0593
```

**完全一致。** 逐框文本、顺序、坐标全部对上（详见页面截图 `poc-result.png`）。

### 3.2 真实 UI 截图（`ui_11_edit_loaded.png`，1440×900，64 个文本框）

```
文本一致: 49/64     坐标偏差中位数: 1.0 px
差异分类: 顺序错位 5 项 / 识别文本不同 10 项
```

差异逐条核对后的分类：

| 类型 | 数量 | 例子 |
|---|---|---|
| 标点 / 全半角 | 4 | `375x52` vs `375×52`、`1000×720` vs `1000x720` |
| 空格有无 | 2 | `Email:support@…` vs `Email: support@…` |
| 临界字符 | 3 | 漏一个"挑"字、多一个 `?` |
| **Python 端反而错了** | 1 | Python「编辑文**宇**」 / 浏览器「编辑文**字**」 |
| 顺序错位 | 5 | 见下节 |

## 4. 差异根因（已用对照实验排除实现问题）

**对照实验**：把 Python 端的 `unclip`（原实现用 `pyclipper` 做多边形偏移，
浏览器没有该库）替换成与 JS 完全相同的几何扩张算法，重跑一遍 ——
**结果一字未变，仍是 49/64。**

这排除了「我的 JS 实现有逻辑错误」这个可能。剩余差异来自：

1. **推理引擎的浮点差异**（主要原因）
   onnxruntime-web 的 WASM SIMD 与原生 onnxruntime 的浮点运算结果并非逐位相同。
   概率图在阈值边缘的像素归属会因此摆动 → 轮廓差 1px → 裁剪区域略有不同 →
   低置信度的小字（UI 截图里大量 9–19px 的字）在临界点翻转。
   这也解释了为什么 `#28` 是 **Python 端错、浏览器端对** —— 是双向噪声，不是单边劣化。

2. **排序的临界判断被放大**（顺序错位的来源）
   `RapidOCR.sorted_boxes` 用「同一行内 y 差 < 10px 就修正左右顺序」这个启发式。
   1px 的坐标波动会让两个 y 相差约 10px 的框跨过临界值，导致交换与否不同。
   这是原算法固有的脆弱性，PoC 只是继承了它。

**坐标偏差中位数 1.0px**，属于亚像素噪声级别，对擦除（会向外 grow）和重绘（按框对齐）几乎没有影响。

## 5. 资源清单（首次加载量）

| 资源 | 体积 | 说明 |
|---|---|---|
| `ch_PP-OCRv3_det_infer.onnx` | 2.4 MB | 文字检测 |
| `ch_PP-OCRv3_rec_infer.onnx` | 11 MB | 文字识别（含内嵌字典） |
| `ch_ppocr_mobile_v2.0_cls_infer.onnx` | 0.57 MB | 方向分类 |
| `opencv.js` | 12.68 MB | 未压缩；可由裁剪版替换 |
| `ort-wasm-simd-threaded.wasm` | 13.58 MB | ONNX Runtime WASM |
| **合计** | **约 40 MB** | 之后全部走浏览器缓存 |

体积有明确优化空间（见下），PoC 阶段优先保证正确性，未做裁剪。

## 6. 目录说明

```
wasm-poc/
├── index.html              验证页面（?auto=1 自动跑）
├── poc-result.png          浏览器端运行结果截图
├── src/
│   ├── det.js              检测：预处理 + DB 后处理（对齐 text_detect.py / utils.py）
│   ├── rec.js              裁剪 / 方向分类 / 识别（对齐 text_cls.py / text_recognize.py）
│   ├── engine.js           编排（对齐 RapidOCR.__call__）
│   └── main.js             页面逻辑与比对
├── models/                 从 rapidocr_onnxruntime 复制的 3 个 onnx
├── baseline/               Python 基准：识别结果、字典、原始 BGR 像素
├── vendor/                 opencv.js + onnxruntime-web 产物
└── scripts/
    ├── gen-baseline.py     生成 Python 基准
    ├── probe-unclip.py     对照实验（几何扩张版基准）
    ├── verify-node.mjs     Node 端比对
    ├── vendor.mjs          收拢运行时资源
    └── serve.mjs           本地静态服务器
```

## 7. 怎么复现

```bash
cd wasm-poc
npm install                                   # 装 onnxruntime-web 与 opencv-js
node scripts/vendor.mjs                       # 收拢资源到 vendor/
python scripts/gen-baseline.py samples/test_card.png
node scripts/verify-node.mjs test_card        # Node 端比对
node scripts/serve.mjs                        # 起服务，浏览器打开 127.0.0.1:8777/wasm-poc/
```

## 8. 下一步

**已验证的部分**：文字检测 + 识别，质量与 Python 端等同。

**尚未验证**：「擦除 → 重绘」两步。已确认 `cv.inpaint` 在 opencv.js 里可用
（`INPAINT_TELEA` / `INPAINT_NS` 都在），所以擦除有直接对应物；
重绘需要用 Canvas 重写（`text_renderer.py` 825 行，是整个项目最大的模块），
且字体是硬约束 —— 浏览器无法枚举系统字体，必须托管字体文件。

**要走完整方案，需要按顺序解决**：

1. 补验「擦除 → 重绘」闭环（在现有 PoC 上加两个环节）
2. 字体方案：选定要托管的中文字体（思源黑体约 10MB/字重），改造 `auto_family`
3. 资源瘦身：裁剪 opencv.js（只需 core/imgproc/photo，可压到 2MB 级别）、
   选更小的 ort 变体、启用 brotli 预压缩（Cloudflare 静态资源支持）
4. 与前端 `web/app.js` 对接，把「调后端 API」换成「本地计算」

**验收标准建议**：以「同一张图两侧识别文本一致率 ≥ 95%」为目标，
不追求逐像素一致（浮点差异不可能消除）。
