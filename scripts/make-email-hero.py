# Build the email hero: the petition page's photograph, treated the same way,
# with the campaign mark centred on it.
#
# Run from the repo root:  python3 scripts/make-email-hero.py
#
# Two things here are not obvious and cost time to work out.
#
# First, the logo PNG ships with a hard white keyline traced around every
# letter, plus the grey anti-aliasing under that keyline. On a white page it is
# invisible. On a photograph it reads as a badly cut-out logo, and no amount of
# adjusting the background hides it. It has to come off the artwork itself.
#
# Second, the mark is navy and dark red and was drawn for a light ground, so
# once the keyline is gone it needs one to sit on. A hard panel behind it looks
# like a sticker, so the photograph is lifted underneath it instead: a wide,
# heavily blurred wash with no edge anywhere.
from PIL import Image, ImageEnhance, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets")
OUT = os.path.join(SRC, "email-hero.jpg")

# Shallower than the source is tall on purpose: the top forty per cent of that
# photograph is empty sky, and cropping it away is what puts the marching
# column in the frame instead of a grey field.
W, H = 1200, 420          # displays at 600x210, doubled for retina
LOGO_W = 620
WASH = (247, 243, 234)    # campaign cream, as the lifted ground
NAVY = (15, 27, 51)       # campaign deepest, for the scrim


def clean_logo(path, split=636):
    """Dissolve the white keyline, and the grey anti-aliasing under it.

    Region aware, because the two halves of the mark tolerate different force.
    The wordmark is pure navy and red on transparency, so ANY colourless pixel
    there is keyline and can go, all the way down into the greys. The building
    is photographic sandstone with real grey shadow in it, so only the near
    white is safe to remove there, or the stone develops holes.

    Alpha is reduced on a ramp rather than cut at a threshold. A threshold
    leaves the letterforms jagged."""
    im = Image.open(path).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            lum = max(r, g, b)
            sat = lum - min(r, g, b)
            lo, hi, sat_max = (96, 190, 34) if x >= split else (206, 236, 26)
            if sat > sat_max or lum < lo:
                continue
            t = 1.0 if lum >= hi else (lum - lo) / float(hi - lo)
            px[x, y] = (r, g, b, int(a * (1.0 - t)))
    return im


# ---- 1. the photograph, cropped the way the petition page crops it ----------
photo = Image.open(os.path.join(SRC, "ww1-troops.jpg")).convert("RGB")
sw, sh = photo.size
crop_h = int(sw / (W / H))
if crop_h <= sh:
    # Biased downward, away from the sky and into the ranks.
    top = int((sh - crop_h) * 0.58)
    photo = photo.crop((0, top, sw, top + crop_h))
else:
    crop_w = int(sh * (W / H))
    left = (sw - crop_w) // 2
    photo = photo.crop((left, 0, left + crop_w, sh))
photo = photo.resize((W, H), Image.LANCZOS)

# Greyscale, as on the page. The subject is the ranks, not the uniforms.
photo = photo.convert("L").convert("RGB")
photo = ImageEnhance.Contrast(photo).enhance(1.05)

# ---- 2. the scrim ----------------------------------------------------------
scrim = Image.new("RGB", (W, H), NAVY)
mask = Image.new("L", (1, H))
for y in range(H):
    t = y / (H - 1)
    mask.putpixel((0, y), int(255 * (0.24 + 0.22 * t)))   # 24% at top, 46% at base
photo = Image.composite(scrim, photo, mask.resize((W, H)))

# ---- 3. the lifted ground, then the mark -----------------------------------
logo = clean_logo(os.path.join(SRC, "logo-horizontal.png"))
logo = logo.resize((LOGO_W, int(logo.height * LOGO_W / logo.width)), Image.LANCZOS)
lx, ly = (W - logo.width) // 2, (H - logo.height) // 2

# A rectangle blurred far past its own size, so what survives is a gradient and
# there is no edge to see. The blur radius has to stay large relative to the
# padding or a soft-cornered box becomes visible.
PAD, BLUR, PEAK = 70, 58, 0.93
glow = Image.new("L", (W, H), 0)
glow.paste(Image.new("L", (logo.width + PAD * 2, logo.height + PAD * 2), 255),
           (lx - PAD, ly - PAD))
glow = glow.filter(ImageFilter.GaussianBlur(BLUR)).point(lambda v: int(v * PEAK))
photo = Image.composite(Image.new("RGB", (W, H), WASH), photo, glow)

photo.paste(logo, (lx, ly), logo)
photo.save(OUT, "JPEG", quality=88, optimize=True, progressive=True)
print("wrote", OUT, photo.size, str(os.path.getsize(OUT) // 1024) + "KB")
