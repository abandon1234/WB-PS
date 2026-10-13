# 把测台导出的 JS 抹字结果与 Python 同构实现逐像素对拍
import sys, os
import numpy as np
import cv2
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import app.text_eraser as te

NAMES = ['solid', 'dark', 'gray', 'grad', 'texture']
PAD2 = {'x': 29, 'y': 129, 'w': 306, 'h': 21}
bad = 0
for k in NAMES:
    fin = f'tools/.dbg-out/{k}_in.png'
    fjs = f'tools/.dbg-out/{k}_PAD2_js.png'
    if not (os.path.exists(fin) and os.path.exists(fjs)):
        print(f'{k}: 缺文件，跳过'); bad += 1; continue
    bgr = cv2.imread(fin)
    js = cv2.imread(fjs)
    py, meta = te.erase(bgr, PAD2, method='auto', grow=3)
    d = np.abs(js.astype(int) - py.astype(int))
    npx = int((d.max(axis=2) > 0).sum())
    ok = d.max() == 0
    if not ok:
        bad += 1
    print(f'{k:8s} {"OK " if ok else "DIFF"} 方法={meta["method"]:7s} solid={meta["bg_solid"]!s:5s}'
          f' level={meta["bg_level"]:3d} residual={meta["residual"]:<7} leftover={meta["leftover_max"]!s:4s}'
          f'  maxΔ={int(d.max())} 差异像素={npx}')
print('\n结论：', 'JS 与 Python 逐像素完全一致' if bad == 0 else f'{bad} 个场景不一致')
