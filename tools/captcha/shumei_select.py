#!/usr/bin/env python3
"""
数美点选验证码（select / spatial_select）求解器 —— 纯 CV，不调模型。

题面形如：「点击图中最小的绿色三棱柱」「点击图中最大的蓝色圆柱」

流程：
  1. HSV 饱和度分割 → 提取彩色物体（背景是灰白渐变，饱和度极低）
  2. 连通域 → 每个物体的包围盒 / 面积 / 重心 / 轮廓
  3. 形状分类：按轮廓逼近顶点数 + 填充率 + 顶底宽度比
  4. 颜色分类：按区域内 HSV 中位色
  5. 解析题面里的「颜色 + 形状 + 大小/序数」→ 排序 → 输出坐标（归一化 + 像素）

用法：
  python3 shumei_select.py --img crop.png --prompt "点击图中最小的绿色三棱柱"
  python3 shumei_select.py --img crop.png --prompt "..." --offset 606,385   # 换算回整页坐标
  python3 shumei_select.py --img crop.png --debug /tmp/annotated.png        # 输出标注图
输出：JSON {pick:{x,y,nx,ny,color,shape,area}, candidates:[...]}
"""
import argparse
import json
import re
import sys

import cv2
import numpy as np

# ---------- 颜色 ----------
def color_name(bgr):
    h, s, v = cv2.cvtColor(np.uint8([[bgr]]), cv2.COLOR_BGR2HSV)[0][0]
    h = int(h) * 2  # OpenCV H in [0,180] → 度
    if s < 60 or v < 40:
        return "gray"
    if h < 15 or h >= 345: return "red"
    if h < 40:  return "orange"
    if h < 70:  return "yellow"
    if h < 165: return "green"
    if h < 260: return "blue"
    if h < 320: return "purple"
    return "red"

COLOR_ALIASES = {
    "红": "red", "橙": "orange", "黄": "yellow", "绿": "green", "青": "green",
    "蓝": "blue", "紫": "purple", "灰": "gray", "黑": "gray", "白": "gray",
}

# ---------- 形状 ----------
def shape_of(cnt, mask_crop):
    """返回 (shape, detail)。shape ∈ tri/quad/cylinder/cone/sphere/unknown"""
    area = cv2.contourArea(cnt)
    x, y, w, h = cv2.boundingRect(cnt)
    if w == 0 or h == 0:
        return "unknown", {}
    peri = cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, 0.035 * peri, True)
    nv = len(approx)
    fill = area / float(w * h)                    # 填充率
    # 顶/底宽度比：圆柱顶部圆润、三角体顶部尖
    roi = mask_crop  # 已经是 bbox 区域，不要再按 (y,x) 偏移切一次
    rows = np.where(roi.any(axis=1))[0]
    def width_at(frac):
        if len(rows) == 0: return 0
        r = int(rows[0] + (rows[-1] - rows[0]) * frac)
        r = max(0, min(roi.shape[0] - 1, r))
        cols = np.where(roi[r])[0]
        return len(cols)
    top = width_at(0.12); mid = width_at(0.5); bot = width_at(0.9)
    detail = {"vertices": nv, "fill": round(fill, 3), "top": top, "mid": mid, "bot": bot}

    # 三角体：顶部很窄、底部宽
    if top <= max(2, mid * 0.35) and bot >= mid * 0.8 and fill < 0.75:
        return "tri", detail
    # 圆柱/立方体：上下等宽
    if mid and bot and abs(top - bot) <= max(4, 0.22 * mid) and fill >= 0.55:
        # 圆柱轮廓更接近矩形且左右边是直线；立方体有斜切面 → 填充率略低
        return ("cylinder" if fill >= 0.72 else "quad"), detail
    if nv <= 4 and fill < 0.6:
        return "tri", detail
    return "quad", detail

SHAPE_ALIASES = {
    "三棱柱": "tri", "三棱锥": "tri", "三角": "tri", "棱锥": "tri", "锥体": "tri",
    "立方体": "quad", "正方体": "quad", "方块": "quad", "四棱": "quad",
    "圆柱": "cylinder", "柱体": "cylinder",
    "球": "sphere", "圆球": "sphere",
}

# ---------- 主流程 ----------
def detect(img_path, min_area=250):
    img = cv2.imread(img_path, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"读不到图片: {img_path}")
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # 背景是灰白渐变：饱和度低。彩色物体饱和度高。
    s = hsv[:, :, 1]; v = hsv[:, :, 2]
    mask = ((s > 70) & (v > 45)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, labels, stats, cents = cv2.connectedComponentsWithStats(mask, 8)

    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < min_area:
            continue
        comp = (labels == i).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        cnt = max(cnts, key=cv2.contourArea)
        mask_crop = comp[y:y + h, x:x + w]
        shape, detail = shape_of(cnt, mask_crop)
        bgr = img[comp.astype(bool)].mean(axis=0)
        cx, cy = cents[i]
        out.append({
            "x": float(cx), "y": float(cy), "area": int(area),
            "bbox": [int(x), int(y), int(w), int(h)],
            "color": color_name(bgr), "shape": shape, **detail,
        })
    out.sort(key=lambda d: d["area"], reverse=True)
    for idx, d in enumerate(out):
        d["rank_by_area"] = idx + 1
    return img, out


def parse_prompt(text):
    color = next((COLOR_ALIASES[k] for k in COLOR_ALIASES if k in text), None)
    shape = None
    for k, v in SHAPE_ALIASES.items():
        if k in text:
            shape = v
            break
    want_min = bool(re.search(r"最小|最细|最窄", text))
    want_max = bool(re.search(r"最大|最粗|最宽", text))
    ordinals = {"第一": 1, "第二": 2, "第三": 3, "第四": 4, "第五": 5}
    order = next((v for k, v in ordinals.items() if k in text), None)
    count = None
    m = re.search(r"(\d+)\s*个", text)
    if m:
        count = int(m.group(1))
    return {"color": color, "shape": shape, "min": want_min, "max": want_max,
            "ordinal": order, "count": count}


def solve(img_path, prompt, offset=(0, 0), debug=None):
    img, cands = detect(img_path)
    q = parse_prompt(prompt)
    pool = [c for c in cands if (not q["color"] or c["color"] == q["color"])]
    shaped = [c for c in pool if (not q["shape"] or c["shape"] == q["shape"])]
    if shaped:
        pool = shaped
    if not pool:
        pool = cands
    pool = sorted(pool, key=lambda d: d["area"], reverse=bool(q["max"]))
    pick = pool[0] if pool else None

    if debug and pick:
        vis = img.copy()
        for c in cands:
            x, y, w, h = c["bbox"]
            hit = c is pick
            cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 0, 255) if hit else (0, 200, 0), 2 if hit else 1)
            cv2.putText(vis, f'{c["color"]}/{c["shape"]}', (x, max(10, y - 4)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255) if hit else (0, 160, 0), 1)
        if pick:
            cv2.circle(vis, (int(pick["x"]), int(pick["y"])), 9, (0, 0, 255), 2)
        cv2.imwrite(debug, vis)

    res = {"prompt": prompt, "query": q, "candidates": cands, "pick": None}
    if pick:
        h, w = img.shape[:2]
        res["pick"] = {
            "x": round(pick["x"] + offset[0], 1), "y": round(pick["y"] + offset[1], 1),
            "nx": round(pick["x"] / w, 4), "ny": round(pick["y"] / h, 4),
            "color": pick["color"], "shape": pick["shape"], "area": pick["area"],
        }
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--img", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--offset", default="0,0", help="裁图左上角在整页里的坐标 x,y")
    ap.add_argument("--debug")
    a = ap.parse_args()
    off = tuple(float(v) for v in a.offset.split(","))
    print(json.dumps(solve(a.img, a.prompt, off, a.debug), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
