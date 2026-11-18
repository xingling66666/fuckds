#!/usr/bin/env python3
"""
人机验证的 CV 工具（不依赖 torch，只用 numpy + Pillow）。

两个能力：
1) drag-offset  : hCaptcha「拖动滑块完成拼图」——给出背景图和拼图块，算出目标偏移
2) slice-grid   : hCaptcha「选出所有 XX」——把九宫格切成单张瓦片，交给视觉模型判定

用法：
  python3 cv.py drag-offset --bg bg.png --piece piece.png [--json]
  python3 cv.py slice-grid  --img grid.png --rows 3 --cols 3 --out /tmp/tiles
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image


def _load_gray(path: str) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    return np.asarray(img).astype(np.float32)


def _edge(a: np.ndarray) -> np.ndarray:
    """Sobel 边缘强度（灰度），用梯度幅值近似，免 opencv。支持 2D / 3D 输入。"""
    g = a.mean(axis=2) if a.ndim == 3 else a.astype(np.float32)
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    return np.sqrt(gx * gx + gy * gy)


def drag_offset(bg_path: str, piece_path: str, scales=None) -> dict:
    """
    在背景图里找拼图块的落点。

    思路：拼图块是背景里被"挖走"的一块，所以最匹配的位置通常表现为**边缘差异最小**；
    同时块本身有独特纹理，直接做归一化互相关（NCC）也有效。
    两种评分加权，取最优；再做多尺度以容忍缩放差异。
    """
    bg = _load_gray(bg_path)
    piece = _load_gray(piece_path)

    bg_g = bg.mean(axis=2)
    pc_g = piece.mean(axis=2)
    bg_e = _edge(bg)
    pc_e = _edge(piece)

    h, w = pc_g.shape
    H, W = bg_g.shape

    best = {"x": 0, "y": 0, "score": -1e9, "scale": 1.0}
    if scales is None:
        scales = [1.0, 0.9, 1.1, 0.8, 1.2]

    for s in scales:
        ph, pw = max(8, int(h * s)), max(8, int(w * s))
        if ph > H or pw > W:
            continue
        pg = np.asarray(Image.fromarray(pc_g.astype(np.uint8)).resize((pw, ph))).astype(np.float32)
        pe = np.asarray(Image.fromarray(pc_e.astype(np.float32)).resize((pw, ph))).astype(np.float32)

        # 逐位置滑动（步长 1 在 300x200 上完全够快）
        best_local = (-1e9, 0, 0)
        for y in range(0, H - ph + 1, 1):
            row = bg_g[y:y + ph]
            for x in range(0, W - pw + 1, 1):
                win = row[:, x:x + pw]
                # NCC（去均值归一化）
                a = win - win.mean()
                b = pg - pg.mean()
                denom = (np.sqrt((a * a).sum()) * np.sqrt((b * b).sum())) + 1e-6
                ncc = float((a * b).sum() / denom)
                if ncc > best_local[0]:
                    best_local = (ncc, x, y)
        score, x, y = best_local
        if score > best["score"]:
            best = {"x": int(x), "y": int(y), "score": round(score, 4), "scale": s}
    return best


def slice_grid(img_path: str, rows: int, cols: int, out_dir: str) -> list:
    img = Image.open(img_path).convert("RGB")
    W, H = img.size
    tw, th = W // cols, H // rows
    os.makedirs(out_dir, exist_ok=True)
    tiles = []
    for r in range(rows):
        for c in range(cols):
            box = (c * tw, r * th, (c + 1) * tw, (r + 1) * th)
            path = os.path.join(out_dir, f"tile_{r * cols + c + 1}.png")
            img.crop(box).save(path)
            tiles.append({"index": r * cols + c + 1, "path": path, "box": box})
    return tiles


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("drag-offset")
    d.add_argument("--bg", required=True)
    d.add_argument("--piece", required=True)

    r = sub.add_parser("repair-detect")
    r.add_argument("--img", required=True)
    r.add_argument("--rows", type=int, default=4)
    r.add_argument("--cols", type=int, default=4)
    r.add_argument("--box", default="")

    g = sub.add_parser("slice-grid")
    g.add_argument("--img", required=True)
    g.add_argument("--rows", type=int, default=3)
    g.add_argument("--cols", type=int, default=3)
    g.add_argument("--out", required=True)

    args = ap.parse_args()
    if args.cmd == "drag-offset":
        print(json.dumps(drag_offset(args.bg, args.piece), ensure_ascii=False))
    elif args.cmd == "repair-detect":
        box = [int(v) for v in args.box.split(",")] if args.box else None
        print(json.dumps(repair_detect(args.img, args.rows, args.cols, box), ensure_ascii=False))
    elif args.cmd == "slice-grid":
        print(json.dumps(slice_grid(args.img, args.rows, args.cols, args.out), ensure_ascii=False))




# ---------------------------------------------------------------------------
# hCaptcha「修复图案」拖拽题：检测左侧可拖元素 + 网格空位 + 匹配关系
# ---------------------------------------------------------------------------

def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    if a is None or b is None:
        return -2.0
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    if a.size == 0 or b.size == 0 or a.shape[0] < 2 or a.shape[1] < 2:
        return -2.0
    if a.shape != b.shape:
        from PIL import Image as _I
        b = np.asarray(_I.fromarray(b.astype(np.uint8)).resize((a.shape[1], a.shape[0]))).astype(np.float32)
    a = a - a.mean()
    b = b - b.mean()
    den = (np.sqrt((a * a).sum()) * np.sqrt((b * b).sum())) + 1e-6
    return float((a * b).sum() / den)


def _icon_score(tile: np.ndarray) -> float:
    """图标"有内容"的程度：边缘能量。空白格几乎没有边缘。"""
    e = _edge(tile)
    return float(e.mean())


def repair_detect(img_path: str, rows: int = 4, cols: int = 4, box=None) -> dict:
    """
    识别「修复图案」题面：
      - 左侧深色面板：可拖元素（每个一块）
      - 右侧浅色网格：rows×cols 格，其中若干格是"空位"（缺图案）
    返回：pieces[{x,y,w,h}]、grid 几何、holes[{row,col,x,y}]、以及 piece→hole 的匹配建议。

    判定依据：
      - 空位：格内边缘能量显著低于同列其它格（图案缺失）
      - 匹配：每列图案一致（hCaptcha 这类题按列重复），用列内模版做 NCC
    """
    img = Image.open(img_path).convert("RGB")
    if box:
        # box 传的是 (x, y, w, h)，PIL.crop 要 (left, top, right, bottom)
        bx, by, bw, bh = (int(v) for v in box)
        img = img.crop((bx, by, bx + bw, by + bh))
    a = np.asarray(img).astype(np.float32)
    H, W = a.shape[:2]
    gray = a.mean(axis=2)

    # 1) 找左侧深色面板的右边界（深色区域平均亮度低）
    col_bright = gray.mean(axis=0)
    dark_cols = np.where(col_bright < 110)[0]
    panel_right = int(dark_cols.max()) if len(dark_cols) else 0

    # 2) 网格区域：面板右侧到画面右侧中，边缘能量最高的连续带
    edge = _edge(a)
    col_edge = edge.mean(axis=0)
    row_edge = edge.mean(axis=1)
    right_zone = np.arange(max(panel_right + 5, 0), W)
    if len(right_zone) < 50:
        raise ValueError("找不到网格区域")
    gx0 = int(right_zone[np.argmax(col_edge[right_zone][: min(len(right_zone), 200)])]) if len(right_zone) else 0
    # 用边缘能量确定网格上下界
    ys = np.where(row_edge > row_edge.mean() * 1.2)[0]
    gy0, gy1 = int(ys.min()), int(ys.max()) if len(ys) else (int(H * 0.2), int(H * 0.8))

    # 3) 网格左边：从面板右侧扫描，找第一段"浅色 + 有边缘"的列
    grid_x0 = None
    for x in range(panel_right + 1, W - 40):
        if gray[:, x].mean() > 140 and col_edge[x] > col_edge.mean() * 0.8:
            grid_x0 = x
            break
    grid_x0 = grid_x0 or (panel_right + 8)
    # 网格右边：最后一列满足"有边缘"
    grid_x1 = None
    for x in range(W - 1, grid_x0 + 40, -1):
        if col_edge[x] > col_edge.mean() * 0.8 and gray[:, x].mean() > 140:
            grid_x1 = x
            break
    grid_x1 = grid_x1 or (W - 8)

    cell_w = (grid_x1 - grid_x0) / cols
    cell_h = (gy1 - gy0) / rows

    cells = []
    for r in range(rows):
        for c in range(cols):
            x0 = int(grid_x0 + c * cell_w)
            y0 = int(gy0 + r * cell_h)
            x1 = int(x0 + cell_w)
            y1 = int(y0 + cell_h)
            tile = gray[y0:y1, x0:x1]
            cells.append({"row": r, "col": c, "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0,
                          "icon": round(_icon_score(tile), 3), "tile": tile})

    # 4) 每列取"图标分"中位数作为模板；显著偏低的判为空位
    holes = []
    col_templates = {}
    for c in range(cols):
        col_cells = [cell for cell in cells if cell["col"] == c]
        scores = sorted(cell["icon"] for cell in col_cells)
        med = scores[len(scores) // 2]
        best = max(col_cells, key=lambda cell: cell["icon"])
        col_templates[c] = best["tile"]
        for cell in col_cells:
            if cell["icon"] < med * 0.55:
                holes.append({"row": cell["row"], "col": c, "x": cell["x"], "y": cell["y"],
                              "w": cell["w"], "h": cell["h"]})

    # 5) 左侧元素：面板内、上下排列的方块（按连通的行亮度分段）
    panel = gray[:, : max(panel_right - 1, 1)]
    row_has = panel.max(axis=1) > 150  # 元素比背景亮
    pieces = []
    run_start = None
    for y in range(len(row_has)):
        if row_has[y] and run_start is None:
            run_start = y
        elif not row_has[y] and run_start is not None:
            if y - run_start > 30:
                xs = np.where(panel[run_start:y].max(axis=0) > 150)[0]
                if len(xs):
                    pieces.append({"x": int(xs.min()), "y": int(run_start), "w": int(xs.max() - xs.min()),
                                   "h": int(y - run_start), "cx": int((xs.min() + xs.max()) / 2),
                                   "cy": int((run_start + y) / 2), "tile": gray[run_start:y, xs.min():xs.max()]})
            run_start = None
    if run_start is not None and len(row_has) - run_start > 30:
        xs = np.where(panel[run_start:].max(axis=0) > 150)[0]
        if len(xs):
            pieces.append({"x": int(xs.min()), "y": int(run_start), "w": int(xs.max() - xs.min()),
                           "h": int(len(row_has) - run_start), "cx": int((xs.min() + xs.max()) / 2),
                           "cy": int((run_start + len(row_has)) / 2), "tile": gray[run_start:, xs.min():xs.max()]})

    # 6) 匹配：元素 → 列（NCC 与列模板），再取该列最上面的空位
    plan = []
    used = set()
    for piece in pieces:
        best_col, best_score = None, -2
        for c, tpl in col_templates.items():
            s = _ncc(piece["tile"], tpl)
            if s > best_score:
                best_col, best_score = c, s
        target = next((h for h in holes if h["col"] == best_col and (h["row"], h["col"]) not in used), None)
        if target:
            used.add((target["row"], target["col"]))
            plan.append({"from": {"x": piece["cx"], "y": piece["cy"]},
                         "to": {"x": target["x"] + target["w"] // 2, "y": target["y"] + target["h"] // 2},
                         "col": best_col, "score": round(best_score, 3)})

    for cell in cells:
        del cell["tile"]
    return {
        "panel_right": panel_right,
        "grid": {"x": grid_x0, "y": gy0, "w": grid_x1 - grid_x0, "h": gy1 - gy0,
                 "cell_w": round(cell_w, 1), "cell_h": round(cell_h, 1)},
        "pieces": [{k: v for k, v in p.items() if k != "tile"} for p in pieces],
        "holes": holes,
        "plan": plan,
    }


if __name__ == "__main__":
    sys.exit(main())
