# Build the email hero: the petition page's photograph, treated the same way,
# with the campaign mark centred on a light plate.
#
# The plate is not decoration. The logo is navy and dark red on transparent and
# it was drawn for a white ground, so laid straight onto a greyscale trench
# photograph it disappears. The site already solves this the same way: the mark
# gets its own light bar wherever the ground behind it is dark.
from PIL import Image, ImageEnhance
import os

# Run from the repo root:  python3 scripts/make-email-hero.py
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets")
OUT = os.path.join(SRC, "email-hero.jpg")

# A shallower banner than the source is tall, which is the point: the top
# forty per cent of the photograph is empty sky, and cropping it away is what
# puts the marching column in the frame instead of a grey field.
W, H = 1200, 420          # displays at 600x210, doubled for retina
PLATE_W, PLATE_H = 620, 200
LOGO_W = 540
CREAM = (250, 246, 239)   # campaign cream
NAVY = (15, 27, 51)       # campaign deepest, for the scrim

# ---- 1. the photograph, cropped the way the petition page crops it ----------
photo = Image.open(os.path.join(SRC, "ww1-troops.jpg")).convert("RGB")
sw, sh = photo.size
target_ratio = W / H
crop_h = int(sw / target_ratio)
if crop_h <= sh:
    # Biased downward, away from the sky and into the ranks.
    top = int((sh - crop_h) * 0.58)
    photo = photo.crop((0, top, sw, top + crop_h))
else:
    crop_w = int(sh * target_ratio)
    left = (sw - crop_w) // 2
    photo = photo.crop((left, 0, left + crop_w, sh))
photo = photo.resize((W, H), Image.LANCZOS)

# Greyscale, as on the page. The subject is the ranks, not the uniforms.
photo = photo.convert("L").convert("RGB")
photo = ImageEnhance.Contrast(photo).enhance(1.05)

# ---- 2. the scrim ----------------------------------------------------------
# Darkens the whole frame so the plate reads as the brightest thing, and deepens
# toward the bottom so the photograph does not fight the copy below it.
scrim = Image.new("RGB", (W, H), NAVY)
mask = Image.new("L", (1, H))
for y in range(H):
    t = y / (H - 1)
    mask.putpixel((0, y), int(255 * (0.24 + 0.22 * t)))   # 24% at top, 46% at base
photo = Image.composite(scrim, photo, mask.resize((W, H)))

# ---- 3. the plate and the mark ---------------------------------------------
logo = Image.open(os.path.join(SRC, "logo-horizontal.png")).convert("RGBA")
lw, lh = logo.size
logo = logo.resize((LOGO_W, int(lh * LOGO_W / lw)), Image.LANCZOS)

plate = Image.new("RGB", (PLATE_W, PLATE_H), CREAM)
plate.paste(logo, ((PLATE_W - logo.width) // 2, (PLATE_H - logo.height) // 2), logo)

px, py = (W - PLATE_W) // 2, (H - PLATE_H) // 2
photo.paste(plate, (px, py))

photo.save(OUT, "JPEG", quality=86, optimize=True, progressive=True)
print("wrote", OUT, photo.size, str(os.path.getsize(OUT) // 1024) + "KB")
