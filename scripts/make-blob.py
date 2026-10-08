# Usage: python3 scripts/make-blob.py design/plant-sphere.jpg public/brand  (needs Pillow), then copy
# public/brand/blob.png to app/icon.png and app/apple-icon.png.
# Builds Bubble Guy from the peach "plant sphere" photo: same canvas layout as the old drawings (eyes in
# the same place, so the blink lids still line up), at 2x (320px).
import sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageChops, ImageEnhance

src, out_dir = sys.argv[1], sys.argv[2]
S = 320
CX, CY, R = 160, 160, 118
im = Image.open(src).convert("RGB")
# The sphere in the photo: centre (104,182), radius ~66. Crop just inside the edge to avoid the white rim.
c, r = (104, 182), 63
tex = im.crop((c[0]-r, c[1]-r, c[0]+r, c[1]+r)).resize((2*R, 2*R), Image.LANCZOS)
# A touch lighter than the photo, so it reads soft and pastel next to the page's own colours.
tex = ImageEnhance.Brightness(tex).enhance(1.1)

def shade(tex, hue_shift=0, sat=1.0):
    t = tex
    if hue_shift or sat != 1.0:
        h, s, v = t.convert("HSV").split()
        h = h.point(lambda x: (x + hue_shift) % 256)
        s = s.point(lambda x: min(255, int(x * sat)))
        t = Image.merge("HSV", (h, s, v)).convert("RGB")
    body = Image.new("RGBA", (2*R, 2*R))
    body.paste(t)
    # Sphere lighting: light from the top left, darker towards the bottom-right rim.
    light = Image.new("L", (2*R, 2*R))
    px = light.load()
    for y in range(2*R):
        for x in range(2*R):
            dx, dy = (x - R) / R, (y - R) / R
            d = math.hypot(dx, dy)
            if d > 1: continue
            nz = math.sqrt(max(0, 1 - d*d))
            lam = max(0, (-0.45*dx - 0.55*dy + 0.7*nz))
            px[x, y] = int(max(0, min(255, 190 + 65*lam - 22*(d**4))))
    shaded = ImageChops.multiply(body.convert("RGB"), Image.merge("RGB", (light,)*3))
    shaded = Image.blend(body.convert("RGB"), shaded, 0.32)
    # Soft round mask with a slightly feathered edge.
    mask = Image.new("L", (2*R*4, 2*R*4))
    ImageDraw.Draw(mask).ellipse((0, 0, 2*R*4-1, 2*R*4-1), fill=255)
    mask = mask.resize((2*R, 2*R), Image.LANCZOS)
    b = shaded.convert("RGBA"); b.putalpha(mask)
    return b, t

def make(name, hue_shift=0, sat=1.0):
    body, t = shade(tex, hue_shift, sat)
    avg = t.resize((1, 1), Image.LANCZOS).getpixel((0, 0))
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # Glow in the sphere's own colour.
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((CX-R-6, CY-R-2, CX+R+6, CY+R+10), fill=(*[int(v*0.6+255*0.4) for v in avg], 140))
    canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(16)))
    canvas.alpha_composite(body, (CX-R, CY-R))
    # Glossy highlight, top left.
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse((CX-82, CY-96, CX-18, CY-52), fill=(255, 255, 255, 85))
    canvas = Image.alpha_composite(canvas, hl.filter(ImageFilter.GaussianBlur(9)))
    # Eyes: warm dark brown with a catchlight (white would vanish on peach). Same place as before.
    eyes = Image.new("RGBA", (S*4, S*4), (0, 0, 0, 0))
    d = ImageDraw.Draw(eyes)
    for ex in (135, 185):
        d.ellipse(((ex-10)*4, (153-16)*4, (ex+10)*4, (153+16)*4), fill=(74, 40, 34, 255))
        d.ellipse(((ex-5)*4, (153-11)*4, (ex+1)*4, (153-3)*4), fill=(255, 255, 255, 235))
    canvas = Image.alpha_composite(canvas, eyes.resize((S, S), Image.LANCZOS))
    canvas.save(f"{out_dir}/{name}.png", optimize=True)

make("blob")
make("blob-green", hue_shift=78, sat=1.1)
make("blob-amber", hue_shift=16, sat=1.25)
make("blob-red", hue_shift=-12, sat=1.35)
