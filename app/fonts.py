# -*- coding: utf-8 -*-
"""字体扫描与管理。

扫描系统字体目录，按「字体族」聚合 regular / bold / italic 变体，
供前端选择并在重绘时精确匹配原图文字样式。
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

from PIL import ImageFont

# 项目自带的字体目录：优先级高于系统字体，
# 用户可把自己的字体丢进来（或通过界面上传），无需改代码。
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER_FONT_DIR = os.path.join(PROJECT_ROOT, "fonts")

# ---------------------------------------------------------------- 字体目录

def _font_dirs() -> List[str]:
    """返回扫描目录，自定义目录排在最前（同名族优先用用户的）。"""
    dirs: List[str] = [USER_FONT_DIR]
    if sys.platform == "win32":
        win = os.environ.get("WINDIR", r"C:\Windows")
        dirs.append(os.path.join(win, "Fonts"))
        local = os.environ.get("LOCALAPPDATA")
        if local:
            dirs.append(os.path.join(local, "Microsoft", "Windows", "Fonts"))
    elif sys.platform == "darwin":
        dirs += ["/System/Library/Fonts", "/Library/Fonts",
                 os.path.expanduser("~/Library/Fonts")]
    else:
        dirs += ["/usr/share/fonts", "/usr/local/share/fonts",
                 os.path.expanduser("~/.fonts"),
                 os.path.expanduser("~/.local/share/fonts")]
    return [d for d in dirs if os.path.isdir(d)]


def _dirs_fingerprint() -> List[list]:
    """扫描目录 + 各自 mtime。任一目录有增删，指纹就变，缓存随之失效。"""
    out: List[list] = []
    for d in _font_dirs():
        try:
            out.append([d, round(os.path.getmtime(d), 1)])
        except OSError:
            out.append([d, 0.0])
    return out


def ensure_user_font_dir() -> str:
    os.makedirs(USER_FONT_DIR, exist_ok=True)
    return USER_FONT_DIR


def is_user_font(path: str) -> bool:
    """判断字体文件是否来自自定义目录（用于界面区分）。"""
    try:
        return os.path.commonpath([os.path.abspath(path), USER_FONT_DIR]) == \
            os.path.abspath(USER_FONT_DIR)
    except ValueError:
        return False


_EXT = (".ttf", ".ttc", ".otf", ".otc")

# 中文字体 > 拉丁字体的排序权重（列表展示更友好）
_PRIORITY = (
    "microsoft yahei", "微软雅黑", "dengxian", "等线", "simhei", "黑体",
    "simsun", "宋体", "nsimsun", "kai", "楷", "fang", "仿宋",
    "source han", "noto sans cjk", "noto serif cjk", "pingfang",
    "segoe ui", "arial", "helvetica", "times new roman", "georgia",
    "calibri", "cambria", "consolas", "courier new", "verdana", "tahoma",
)


def _priority(name: str) -> int:
    low = name.lower()
    for i, key in enumerate(_PRIORITY):
        if key in low:
            return i
    return len(_PRIORITY) + 50


@dataclass
class FontFace:
    """单个字体文件（含 ttc 内的 index）。"""
    family: str
    style: str          # Regular / Bold / Italic / Bold Italic
    path: str
    index: int = 0
    weight: str = "normal"
    italic: bool = False

    @property
    def key(self) -> str:
        return f"{self.path}|{self.index}"

    @property
    def is_bold(self) -> bool:
        s = f"{self.style} {self.weight}".lower()
        return "bold" in s or "black" in s or "heavy" in s or "semibold" in s

    @property
    def is_italic(self) -> bool:
        return self.italic or "italic" in self.style.lower() or "oblique" in self.style.lower()


@dataclass
class FontFamily:
    name: str
    faces: List[FontFace] = field(default_factory=list)

    def find(self, bold: bool = False, italic: bool = False) -> Optional[FontFace]:
        """挑选最接近请求样式的 face。"""
        pool = self.faces
        if not pool:
            return None
        # 精确匹配
        for f in pool:
            if f.is_bold == bold and f.is_italic == italic:
                return f
        # 忽略斜体降级
        for f in pool:
            if f.is_bold == bold:
                return f
        return pool[0]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "faces": [{"path": f.path, "index": f.index, "style": f.style,
                       "bold": f.is_bold, "italic": f.is_italic} for f in self.faces],
        }


_CACHE: Optional[Dict[str, FontFamily]] = None
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".font_cache.json")


def _probe(path: str, index: int) -> Optional[tuple]:
    """读取字体元信息，失败返回 None。"""
    try:
        f = ImageFont.truetype(path, 24, index=index)
        family, style = f.getname()
        if not family:
            return None
        return family, style or "Regular"
    except Exception:
        return None


def _scan() -> Dict[str, FontFamily]:
    families: Dict[str, FontFamily] = {}
    for d in _font_dirs():
        for root, _dirs, files in os.walk(d):
            for fn in files:
                if not fn.lower().endswith(_EXT):
                    continue
                path = os.path.join(root, fn)
                # ttc/otc 是字体集合，逐个 index 探测（上限 20，避免异常文件拖慢）
                indices = range(20) if fn.lower().endswith((".ttc", ".otc")) else (0,)
                for idx in indices:
                    meta = _probe(path, idx)
                    if meta is None:
                        if idx == 0:
                            break          # 不是合集且读取失败 → 跳过该文件
                        continue
                    family, style = meta
                    fam = families.setdefault(family, FontFamily(name=family))
                    # 去重：同 path+index 只登记一次
                    if any(f.path == path and f.index == idx for f in fam.faces):
                        continue
                    fam.faces.append(FontFace(family=family, style=style,
                                              path=path, index=idx))
    return families


def load_fonts(force: bool = False) -> Dict[str, FontFamily]:
    """加载字体库。

    两级缓存：进程内 → 磁盘。磁盘缓存带「扫描目录 + 各自 mtime」指纹，
    所以往自定义目录里加/删字体后，指纹变化会自动重扫，不用手动清缓存。
    """
    global _CACHE
    if _CACHE is not None and not force:
        return _CACHE

    ensure_user_font_dir()
    fingerprint = _dirs_fingerprint()

    if not force and os.path.isfile(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, "r", encoding="utf-8") as fp:
                raw = json.load(fp)
            if isinstance(raw, dict) and raw.get("_fingerprint") == fingerprint:
                data = raw.get("_fonts") or {}
                _CACHE = {
                    name: FontFamily(name=name,
                                     faces=[FontFace(**f) for f in item["faces"]])
                    for name, item in data.items()
                }
                if _CACHE:
                    return _CACHE
        except Exception:                # noqa: BLE001
            pass

    _CACHE = _scan()
    try:
        with open(_CACHE_FILE, "w", encoding="utf-8") as fp:
            json.dump({"_fingerprint": fingerprint,
                       "_fonts": {n: fam.to_dict() for n, fam in _CACHE.items()}},
                      fp, ensure_ascii=False)
    except Exception:                    # noqa: BLE001
        pass
    return _CACHE


def list_families() -> List[dict]:
    """按优先级返回字体族列表（自定义字体排最前）。"""
    fams = load_fonts()
    items = [
        {"name": n,
         "bold": any(f.is_bold for f in fam.faces),
         "user": any(is_user_font(f.path) for f in fam.faces),
         "files": len({(f.path, f.index) for f in fam.faces})}
        for n, fam in fams.items() if fam.faces
    ]
    items.sort(key=lambda x: (0 if x["user"] else 1,
                              _priority(x["name"]), x["name"].lower()))
    return items


# ------------------------------------------------------- 用户字体文件管理

ALLOWED_EXTS = (".ttf", ".otf", ".ttc", ".otc")
MAX_FONT_BYTES = 64 * 1024 * 1024


def list_user_font_files() -> List[dict]:
    """列出自定义目录里的字体文件。"""
    d = ensure_user_font_dir()
    out: List[dict] = []
    for fn in sorted(os.listdir(d)):
        path = os.path.join(d, fn)
        if not os.path.isfile(path) or not fn.lower().endswith(ALLOWED_EXTS):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append({"name": fn, "bytes": st.st_size, "mtime": round(st.st_mtime, 1)})
    return out


def _safe_font_name(filename: str) -> str:
    """清洗文件名，杜绝路径穿越与非法字符。"""
    safe = os.path.basename((filename or "").strip())
    safe = re.sub(r"[^\w\u4e00-\u9fff.\-()+ ]", "_", safe)
    if not safe or safe.startswith("."):
        raise ValueError("字体文件名无效")
    if not safe.lower().endswith(ALLOWED_EXTS):
        raise ValueError("仅支持 " + " / ".join(ALLOWED_EXTS) + " 格式")
    return safe


def add_user_font(filename: str, data: bytes) -> dict:
    """把上传的字体写入自定义目录并热重扫。重名不覆盖，自动加序号。"""
    if len(data) < 512:
        raise ValueError("文件内容过小，可能不是有效字体")
    if len(data) > MAX_FONT_BYTES:
        raise ValueError("字体文件超过 64MB 限制")

    d = ensure_user_font_dir()
    safe = _safe_font_name(filename)
    stem, ext = os.path.splitext(safe)
    target = os.path.join(d, safe)
    i = 2
    while os.path.exists(target):
        target = os.path.join(d, f"{stem}_{i}{ext}")
        i += 1

    with open(target, "wb") as fp:
        fp.write(data)

    # 校验确实能被解析，避免落盘一堆无效文件
    ok = _probe(target, 0) is not None
    if not ok:
        try:
            os.remove(target)
        except OSError:
            pass
        raise ValueError("无法解析该字体文件，请确认是有效的 TTF/OTF/TTC")

    load_fonts(force=True)
    return {"file": os.path.basename(target), "bytes": len(data)}


def remove_user_font(filename: str) -> bool:
    """删除自定义目录里的字体文件（严格限制在本目录内）。"""
    d = os.path.abspath(ensure_user_font_dir())
    safe = _safe_font_name(filename)
    target = os.path.abspath(os.path.join(d, safe))
    if os.path.dirname(target) != d:
        raise ValueError("路径不合法")
    if not os.path.isfile(target):
        return False
    os.remove(target)
    load_fonts(force=True)
    return True


def resolve(family: str, bold: bool = False, italic: bool = False) -> Optional[FontFace]:
    """家族名 + 样式 → 具体字体文件。找不到时逐级降级。"""
    fams = load_fonts()
    if not fams:
        return None
    fam = fams.get(family)
    if fam is None:
        # 模糊匹配（忽略大小写与空格）
        key = (family or "").lower().replace(" ", "")
        for n, f in fams.items():
            if n.lower().replace(" ", "") == key:
                fam = f
                break
    if fam is None:
        # 拿一个能显示中文的兜底字体
        for cand in ("Microsoft YaHei", "微软雅黑", "SimHei", "黑体",
                     "Noto Sans CJK SC", "PingFang SC", "Arial"):
            if cand in fams:
                fam = fams[cand]
                break
    if fam is None:
        fam = next(iter(fams.values()))
    return fam.find(bold=bold, italic=italic)


def recommend(text: str) -> List[str]:
    """根据待渲染文本给出推荐字体族（按语言）。"""
    has_cjk = any("\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff" for ch in text)
    fams = load_fonts()
    if has_cjk:
        order = ["Microsoft YaHei", "微软雅黑", "DengXian", "等线", "SimHei", "黑体",
                 "SimSun", "宋体", "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC"]
    else:
        order = ["Arial", "Helvetica", "Calibri", "Segoe UI", "Verdana",
                 "Times New Roman", "Georgia", "Consolas", "Courier New"]
    out = [n for n in order if n in fams]
    for n in fams:
        if n not in out:
            out.append(n)
    return out[:30]


# ---------------------------------------------------------------- 常用字体白名单
# 系统字体动辄两三百个。做"字形匹配"时若全量比对，很容易选中
# 「比例接近但字形完全不像」的冷门字体（例如 ITC Bookman、ITC Avant Garde Gothic）。
# 把候选限制在实际会被用到的常用字体里，命中率显著更高。

LATIN_COMMON = (
    "Arial", "Helvetica", "Helvetica Neue", "Segoe UI", "Tahoma", "Verdana",
    "Calibri", "Candara", "Corbel", "Trebuchet MS", "Franklin Gothic Medium",
    "Times New Roman", "Georgia", "Cambria", "Constantia", "Palatino Linotype",
    "Consolas", "Courier New", "Lucida Console", "Cascadia Mono", "Cascadia Code",
    "Roboto", "Open Sans", "Lato", "Source Sans Pro", "Inter", "Noto Sans",
    "Arial Narrow", "Arial Black", "Impact", "Segoe UI Variable",
)

CJK_COMMON = (
    "Microsoft YaHei", "微软雅黑", "Microsoft YaHei UI", "DengXian", "等线",
    "SimHei", "黑体", "SimSun", "宋体", "NSimSun", "新宋体",
    "KaiTi", "楷体", "FangSong", "仿宋", "Microsoft JhengHei", "微软正黑体",
    "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Source Han Sans CN",
    "Noto Sans CJK SC", "Noto Serif CJK SC", "WenQuanYi Micro Hei",
    "STXihei", "STHeiti", "YouYuan", "幼圆", "LiSu", "隶书",
)


def common_candidates(text: str = "", limit: int = 22) -> List[str]:
    """返回常用字体里实际存在的候选，按与文本语言的匹配度排序。"""
    fams = load_fonts()
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in text)
    order = (list(CJK_COMMON) + list(LATIN_COMMON)) if has_cjk \
        else (list(LATIN_COMMON) + list(CJK_COMMON))

    out: List[str] = []
    seen = set()
    for name in order:
        if len(out) >= limit:
            break
        if name in fams and name not in seen:
            out.append(name)
            seen.add(name)

    if len(out) < 6:                       # 白名单几乎没命中 → 退回推荐列表
        for name in recommend(text):
            if len(out) >= limit:
                break
            if name not in seen:
                out.append(name)
                seen.add(name)
    return out


def font_path_for(family: str, bold: bool, italic: bool) -> Optional[tuple]:
    face = resolve(family, bold, italic)
    if face is None:
        return None
    return face.path, face.index
