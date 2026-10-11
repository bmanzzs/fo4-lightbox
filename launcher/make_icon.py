"""Draws the FO4 Lightbox icon: a cube lit from above on a dark tile (amber like the viewer's accent).

    python launcher/make_icon.py      (needs Pillow)

Writes launcher/lightbox.ico (16-256 px, for FO4 Lightbox.exe) and web/icon.png (256 px, the page / window icon).
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
S = 1024                                       # drawn large, scaled down for each icon size


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # the tile: dark slate with a soft warm light behind the cube
    tile = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((40, 40, S - 40, S - 40), radius=210, fill=(24, 27, 32, 255))
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((210, 150, 814, 754), fill=(232, 176, 74, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    tile.alpha_composite(Image.composite(glow, Image.new('RGBA', (S, S)), tile.split()[3]))
    img.alpha_composite(tile)
    # the cube: isometric, top face lit, two shaded sides
    cx, cy, r = S / 2, S / 2 + 40, 300
    a = math.radians(30)
    top = (cx, cy - r)
    upr = (cx + r * math.cos(a), cy - r * math.sin(a))
    upl = (cx - r * math.cos(a), cy - r * math.sin(a))
    mid = (cx, cy)
    lor = (cx + r * math.cos(a), cy + r * math.sin(a))
    lol = (cx - r * math.cos(a), cy + r * math.sin(a))
    bot = (cx, cy + r)
    d = ImageDraw.Draw(img)
    d.polygon([top, upr, mid, upl], fill=(250, 214, 138, 255))          # top: in the light
    d.polygon([upl, mid, bot, lol], fill=(219, 150, 52, 255))           # left
    d.polygon([mid, upr, lor, bot], fill=(150, 96, 30, 255))            # right: in shade
    edge = (255, 236, 190, 255)
    w = 18
    for p, q in ((top, upr), (upr, mid), (mid, upl), (upl, top)):
        d.line([p, q], fill=edge, width=w)
    for p, q in ((mid, bot), (upl, lol), (upr, lor), (lol, bot), (lor, bot)):
        d.line([p, q], fill=(255, 214, 140, 200), width=w // 2)
    return img


def main():
    big = draw()
    ico = os.path.join(HERE, 'lightbox.ico')
    big.resize((256, 256), Image.LANCZOS).save(ico, sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48),
                                                            (64, 64), (128, 128), (256, 256)])
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, 'web', 'icon.png'), optimize=True)
    print('wrote', ico, 'and web/icon.png')


if __name__ == '__main__':
    main()
