"""OpenMazelingo のツールバーアイコン(フクロウ)を生成する。
外部素材やSVGを使わず、Pillowの図形描画だけでフラットデザインのフクロウを描き、
高解像度(1024px)で描画してから各サイズにLANCZOS縮小することでアンチエイリアスをかける。
"""

import os
from PIL import Image, ImageDraw

GREEN = (88, 204, 2, 255)
GREEN_DARK = (70, 163, 2, 255)
CREAM = (255, 249, 230, 255)
INK = (60, 60, 60, 255)
BEAK = (255, 168, 40, 255)

CANVAS = 1024
SIZES = [16, 32, 48, 128]

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def draw_owl(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2

    # 耳(小さな三角)
    ear_w = size * 0.16
    ear_h = size * 0.22
    d.polygon(
        [
            (cx - size * 0.30, cy - size * 0.28),
            (cx - size * 0.30 - ear_w * 0.5, cy - size * 0.28 - ear_h),
            (cx - size * 0.14, cy - size * 0.32),
        ],
        fill=GREEN_DARK,
    )
    d.polygon(
        [
            (cx + size * 0.30, cy - size * 0.28),
            (cx + size * 0.30 + ear_w * 0.5, cy - size * 0.28 - ear_h),
            (cx + size * 0.14, cy - size * 0.32),
        ],
        fill=GREEN_DARK,
    )

    # 体(丸みのある本体)
    body_r = size * 0.40
    d.ellipse([cx - body_r, cy - body_r * 1.02, cx + body_r, cy + body_r * 1.02], fill=GREEN)

    # お腹(クリーム色)
    belly_w = size * 0.30
    belly_h = size * 0.34
    d.ellipse(
        [cx - belly_w, cy - belly_h * 0.55, cx + belly_w, cy + belly_h * 0.95],
        fill=CREAM,
    )

    # 目(白目)
    eye_r = size * 0.155
    eye_dx = size * 0.175
    eye_dy = -size * 0.06
    for sign in (-1, 1):
        ex = cx + sign * eye_dx
        ey = cy + eye_dy
        d.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=(255, 255, 255, 255))

    # 瞳(黒目)
    pupil_r = size * 0.07
    for sign in (-1, 1):
        ex = cx + sign * eye_dx
        ey = cy + eye_dy
        d.ellipse(
            [ex - pupil_r, ey - pupil_r, ex + pupil_r, ey + pupil_r], fill=(35, 35, 35, 255)
        )
        # ハイライト
        hl_r = pupil_r * 0.32
        d.ellipse(
            [
                ex - pupil_r * 0.35 - hl_r,
                ey - pupil_r * 0.35 - hl_r,
                ex - pupil_r * 0.35 + hl_r,
                ey - pupil_r * 0.35 + hl_r,
            ],
            fill=(255, 255, 255, 255),
        )

    # くちばし
    beak_w = size * 0.09
    beak_h = size * 0.11
    beak_y = cy + size * 0.06
    d.polygon(
        [
            (cx - beak_w, beak_y),
            (cx + beak_w, beak_y),
            (cx, beak_y + beak_h),
        ],
        fill=BEAK,
    )

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    master = draw_owl(CANVAS)
    for size in SIZES:
        resized = master.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        resized.save(path)
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
