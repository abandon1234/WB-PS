/**
 * 浏览器端 OCR 引擎：det → crop → cls → rec 的编排。
 *
 * 对齐 rapidocr_onnxruntime 的 RapidOCR.__call__：
 *   - Global.min_height=30 / width_height_ratio=8 的短路逻辑（跳过检测）
 *   - sorted_boxes → get_crop_img_list → text_cls → text_recognizer
 *   - filter_boxes_rec_by_score（text_score=0.5 过滤）
 *
 * 模型直接用 rapidocr_onnxruntime 包内自带的那三个 onnx，保证与 Python 端同源。
 */
import {
  calcDetResize, detNormalize, detPostprocess, filterDetBoxes, sortedBoxes,
} from "./det.js";
import {
  clsPreprocess, recPreprocess, cropByBox, ctcDecode, clsDecode,
} from "./rec.js";

export const GLOBAL_CONFIG = {
  textScore: 0.5,
  useAngleCls: true,
  useTextDet: true,
  minHeight: 30,
  widthHeightRatio: 8,
  clsImageShape: [3, 48, 192],
  clsThresh: 0.9,
  clsLabelList: ["0", "180"],
  recImgShape: [3, 48, 320],
};

/** Canvas ImageData(RGBA) → OpenCV BGR Mat（与 cv2.imread 的通道顺序一致） */
export function imageDataToBgrMat(cv, imageData) {
  const { width: w, height: h, data } = imageData;
  const mat = new cv.Mat(h, w, cv.CV_8UC3);
  const dst = mat.data;
  for (let i = 0, n = w * h; i < n; i++) {
    dst[i * 3] = data[i * 4 + 2];
    dst[i * 3 + 1] = data[i * 4 + 1];
    dst[i * 3 + 2] = data[i * 4];
  }
  return mat;
}

/** OpenCV BGR/Gray Mat → ImageData，便于画到 canvas 上看效果 */
export function matToImageData(cv, mat) {
  const h = mat.rows;
  const w = mat.cols;
  const ch = mat.channels();
  const out = new Uint8ClampedArray(w * h * 4);
  const src = mat.data;
  for (let i = 0, n = w * h; i < n; i++) {
    if (ch >= 3) {
      out[i * 4] = src[i * ch + 2];
      out[i * 4 + 1] = src[i * ch + 1];
      out[i * 4 + 2] = src[i * ch];
    } else {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i * ch];
    }
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, w, h);
}

export class OcrEngine {
  constructor(ort, cv, sessions, charList) {
    this.ort = ort;
    this.cv = cv;
    this.det = sessions.det;
    this.cls = sessions.cls;
    this.rec = sessions.rec;
    this.charList = charList;
    this.cfg = GLOBAL_CONFIG;
  }

  /**
   * @param {string} base 资源根目录。默认 /assets —— 这个前缀会被 Service Worker
   *   接管，命中缓存就瞬时返回。onnxruntime-web 从 URL 自己发 fetch，
   *   所以「模型缓存在浏览器里」这件事对这里是完全透明的：换路径不用改逻辑。
   */
  static async create(ort, cv, { base = "/assets", onProgress = () => {}, charList: injected = null } = {}) {
    const load = async (file, label) => {
      onProgress({ phase: "model", label });
      return ort.InferenceSession.create(`${base}/models/${file}`, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    };

    let charList = injected;
    if (!charList) {
      onProgress({ phase: "dict", label: "识别字典" });
      charList = await fetch(`${base}/char_dict.json`).then((r) => r.json());
    }

    // 顺序有讲究：先小后大。检测(2.4MB)+分类(0.57MB)到位就能开始出框，
    // 识别模型 11MB 放最后，用户不必盯着一个进度条干等。
    const det = await load("ch_PP-OCRv3_det_infer.onnx", "文字检测模型");
    const cls = await load("ch_ppocr_mobile_v2.0_cls_infer.onnx", "方向分类模型");
    const rec = await load("ch_PP-OCRv3_rec_infer.onnx", "文字识别模型");

    return new OcrEngine(ort, cv, { det, cls, rec }, charList);
  }

  /** 单张 BGR Mat 跑完整链路，返回与 Python 侧同构的结果 */
  async run(bgrMat, { useDet = true, textScore = null } = {}) {
    const cv = this.cv;
    const ort = this.ort;
    const srcH = bgrMat.rows;
    const srcW = bgrMat.cols;
    // Python 侧 ocr_engine.detect 用 min_score=0.35 过滤；PoC 当时写死 0.5。
    // 这里允许调用方覆盖，保证两侧过滤口径一致，否则 items 数量会对不上。
    const minScore = textScore === null ? this.cfg.textScore : textScore;

    /* ---- 1) 检测（含 min_height / width_height_ratio 短路）---- */
    let boxes;
    if (!useDet || srcH <= this.cfg.minHeight || srcW / srcH > this.cfg.widthHeightRatio) {
      boxes = [[[0, 0], [srcW, 0], [srcW, srcH], [0, srcH]]];
    } else {
      boxes = await this.detectBoxes(bgrMat);
    }
    const sorted = sortedBoxes(boxes);

    /* ---- 2) 逐框：裁剪 → 方向分类 → 识别 ---- */
    const items = [];
    for (const box of sorted) {
      let crop = cropByBox(cv, bgrMat, box);
      try {
        if (this.cfg.useAngleCls) {
          const r = await this.runCls(crop);
          if (r.label.includes("180") && r.score > this.cfg.clsThresh) {
            const rot = new cv.Mat();
            cv.rotate(crop, rot, cv.ROTATE_180);
            crop.delete();
            crop = rot;
          }
        }
        const rec = await this.runRec(crop);
        if (rec.score >= minScore) {
          items.push({
            box,
            text: rec.text,
            score: Math.round(rec.score * 10000) / 10000,
          });
        }
      } finally {
        crop.delete();
      }
    }
    return { items, size: { h: srcH, w: srcW } };
  }

  /** 检测：resize → 归一化 → 推理 → DB 后处理，返回原图坐标下的四点框 */
  async detectBoxes(bgrMat) {
    const cv = this.cv;
    const ort = this.ort;
    const srcH = bgrMat.rows;
    const srcW = bgrMat.cols;

    const { rh, rw } = calcDetResize(srcH, srcW);
    const input = detNormalize(cv, bgrMat, rh, rw);

    const inName = this.det.inputNames[0];
    const outName = this.det.outputNames[0];
    const feeds = { [inName]: new ort.Tensor("float32", input, [1, 3, rh, rw]) };
    const out = (await this.det.run(feeds))[outName];

    const ph = out.dims[2];
    const pw = out.dims[3];
    let boxes = detPostprocess(cv, out.data, pw, ph, srcH, srcW);
    return filterDetBoxes(boxes, srcH, srcW);
  }

  async runCls(crop) {
    const ort = this.ort;
    const [c, h, w] = this.cfg.clsImageShape;
    const pre = clsPreprocess(this.cv, crop, c, h, w);
    const out = await this.cls.run({
      [this.cls.inputNames[0]]: new ort.Tensor("float32", pre.tensor, pre.dims),
    });
    const o = out[this.cls.outputNames[0]];
    return clsDecode(o.data, this.cfg.clsLabelList);
  }

  async runRec(crop) {
    const ort = this.ort;
    const [c, h] = this.cfg.recImgShape;
    const ratio = crop.cols / crop.rows;
    const pre = recPreprocess(this.cv, crop, ratio, c, h);
    const out = await this.rec.run({
      [this.rec.inputNames[0]]: new ort.Tensor("float32", pre.tensor, pre.dims),
    });
    const o = out[this.rec.outputNames[0]];
    return ctcDecode(o.data, o.dims[1], o.dims[2], this.charList);
  }
}
