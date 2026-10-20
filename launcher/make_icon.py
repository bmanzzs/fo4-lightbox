"""Draws the FO4 Lightbox icon: a cube lit from above on DDS View's tile (one look for both tools).

    python launcher/make_icon.py      (needs Pillow)

Writes launcher/lightbox.ico (16-256 px, for FO4 Lightbox.exe; "NIF" under the cube from 48 px, as DDS View's
"DDS") and web/icon.png (256 px, the page / window icon).
"""
import io
import math
import os
import struct

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
S = 1024                                       # drawn large, scaled down for each icon size


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


TILE_MARGIN, TILE_RADIUS = 40, 210             # the tile is DDS View's (Tools/DdsView/make_icon.py): one look for both
TILE_TOP, TILE_BOTTOM, TILE_RIM = (44, 46, 52), (24, 25, 28), (70, 72, 78)


# with the label (48 px and up, as DDS View): the cube in the space DDS View's texel grid takes (y 190-610), "NIF"
# below in the same font, size and place as its "DDS"; smaller sizes: the cube alone, larger (the label can't be read)
LABEL, FONT = 'NIF', r'C:\Windows\Fonts\segoeuib.ttf'
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def draw(label):
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # the tile: grey gradient, lighter at the top, with a rim, so it reads on a dark taskbar too
    m = TILE_MARGIN
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(TILE_TOP, TILE_BOTTOM, y / S) + (255,))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((m, m, S - m, S - m), TILE_RADIUS, fill=255)
    tile = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    cx, cy, r = (S / 2, 400, 215) if label else (S / 2, S / 2 + 20, 285)
    # a soft warm light behind the cube, inside the tile
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    g = r * 0.99
    ImageDraw.Draw(glow).ellipse((cx - g, cy - g - 10, cx + g, cy + g - 10), fill=(232, 176, 74, 80))
    glow = glow.filter(ImageFilter.GaussianBlur(r * 0.42))
    tile.alpha_composite(Image.composite(glow, Image.new('RGBA', (S, S)), mask))
    ImageDraw.Draw(tile).rounded_rectangle((m, m, S - m, S - m), TILE_RADIUS, outline=TILE_RIM + (255,), width=10)
    img.alpha_composite(tile)
    # the cube: isometric, top face lit, two shaded sides
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
    w = round(18 * r / 300)
    for p, q in ((top, upr), (upr, mid), (mid, upl), (upl, top)):
        d.line([p, q], fill=edge, width=w)
    for p, q in ((mid, bot), (upl, lol), (upr, lor), (lol, bot), (lor, bot)):
        d.line([p, q], fill=(255, 214, 140, 200), width=max(1, w // 2))
    if label:
        f = ImageFont.truetype(FONT, 190)
        d.text(((S - d.textlength(LABEL, font=f)) / 2, 660), LABEL, font=f, fill=(236, 236, 236, 255))
    return img


def write_ico(path, images):
    """An .ico of PNG entries, one drawn for each size (as DDS View's)."""
    data = []
    for im in images:
        b = io.BytesIO()
        im.save(b, 'PNG')
        data.append(b.getvalue())
    head = struct.pack('<HHH', 0, 1, len(images))
    off, ent = 6 + 16 * len(images), b''
    for im, dd in zip(images, data):
        n = im.width
        ent += struct.pack('<BBBBHHII', n % 256, n % 256, 0, 0, 1, 32, len(dd), off)
        off += len(dd)
    with open(path, 'wb') as f:
        f.write(head + ent + b''.join(data))


def main():
    full, small = draw(True), draw(False)
    ico = os.path.join(HERE, 'lightbox.ico')
    write_ico(ico, [(full if n >= 48 else small).resize((n, n), Image.LANCZOS) for n in SIZES])
    full.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, 'web', 'icon.png'), optimize=True)
    print('wrote', ico, 'and web/icon.png')


if __name__ == '__main__':
    main()
