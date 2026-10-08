# The Chit agents and Bubble Guy colourways: same sphere, lighting, highlight and eyes as scripts/make-blob.py,
# with the brand veins (from design/plant-sphere.jpg) lit like neon tubing. Needs Pillow and numpy.
#   python3 scripts/make-agents.py <out_dir> <scale> "" neon,aurora      (scale 1 = 320 px; 6 = 1920 px)
# MASK=1 also writes mask-<name>.png (the veins alone, for the flowing-light animation); PRINT=1 drops the glow
# and clips to the sphere for print. public/brand/agents holds neon and aurora at scale 1.5, app/icon.png is
# neon at scale 1.
import sys, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops

out = sys.argv[1]
K = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
S = round(320 * K); CX = CY = round(160 * K); R = round(118 * K); D = 2 * R
rng = np.random.default_rng(7)

def noise(scale, seed):
    r = np.random.default_rng(seed)
    g = max(2, int(D / scale))
    small = Image.fromarray((r.random((g, g)) * 255).astype(np.uint8))
    return np.asarray(small.resize((D, D), Image.BICUBIC), dtype=np.float32) / 255

def fbm(seed, base=60, octaves=5):
    tot = np.zeros((D, D), np.float32); amp = 1; w = 0
    for o in range(octaves):
        tot += amp * noise(base / (2 ** o) * K, seed + o); w += amp; amp *= 0.5
    return tot / w

Y, X = np.mgrid[0:D, 0:D].astype(np.float32) / D

def ramp(stops, t):
    t = np.clip(t, 0, 1); outc = np.zeros(t.shape + (3,), np.float32)
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        m = (t >= p0) & (t <= p1); f = ((t - p0) / max(p1 - p0, 1e-6))[..., None]
        outc[m] = (np.array(c0) * (1 - f) + np.array(c1) * f)[m]
    return outc

def clouds(base, seed, lo, hi, tint_top, tint_bottom, band=(0.25, 0.85), stretch=2.2):
    n = fbm(seed, base=110)
    # Stretch sideways so clouds read as drifting streaks.
    n = np.asarray(Image.fromarray((n * 255).astype(np.uint8)).resize((int(D * stretch), D), Image.BICUBIC).crop((0, 0, D, D)), np.float32) / 255
    a = np.clip((n - lo) / (hi - lo), 0, 1) ** 1.4
    a *= np.clip(1 - np.abs((Y - (band[0] + band[1]) / 2) / ((band[1] - band[0]) / 2)), 0, 1) ** 0.6
    tint = np.array(tint_top) * (1 - Y[..., None]) + np.array(tint_bottom) * Y[..., None]
    shade = 0.85 + 0.15 * np.clip(fbm(seed + 9, base=30), 0, 1)[..., None]
    return base * (1 - a[..., None]) + tint * shade * a[..., None]

# The brand's texture: the peach sphere photo, cropped and sized exactly as in scripts/make-blob.py.
PHOTO = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else "/home/user/dropshipkitchen/design/plant-sphere.jpg"
_im = Image.open(PHOTO).convert("RGB").crop((104 - 63, 182 - 63, 104 + 63, 182 + 63)).resize((D, D), Image.LANCZOS)
_rgb = np.asarray(_im, np.float32)
_L = _rgb.mean(axis=2)
_Lsoft = np.asarray(Image.fromarray(_L.astype(np.uint8)).filter(ImageFilter.GaussianBlur(10 * K)), np.float32) + 1
# The veins are redder and darker than the skin around them: keep both as one "line" signal.
_red = _rgb[..., 0] - (_rgb[..., 1] + _rgb[..., 2]) / 2
_redsoft = np.asarray(Image.fromarray(np.clip(_red, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10 * K)), np.float32)
LINES = np.clip((_red - _redsoft) / 22, -1, 1) - np.clip((_L / _Lsoft - 1) * 3, -1, 1)
# Smooth out photo grain so only the veins read, as on the peach original.
LINES = (np.asarray(Image.fromarray(((LINES + 1) * 127.5).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.6 * K)), np.float32) / 127.5) - 1
SHADE = (_L / _L.mean())[..., None]

def recolour(base, line_rgb, strength=0.5):
    """The photo's veins and light, in a new palette: base colour per pixel, veins pulled toward line_rgb."""
    lit = base * (0.82 + 0.18 * SHADE)
    a = np.clip(LINES, 0, 1)[..., None] * strength
    lift = np.clip(-LINES, 0, 1)[..., None] * 0.08
    return lit * (1 - a) + np.array(line_rgb) * a + 255 * lift

def soft(a, r):
    return np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r * K)), np.float32) / 255

def moon_maps(seed=97):
    """Lunar relief and brightness: many small craters (bowl, rim, bright ejecta around fresh ones), a few
    medium ones, and fine dust. Returns (height, albedo boost)."""
    r = np.random.default_rng(seed)
    h = np.zeros((D, D), np.float32)
    alb = np.zeros((D, D), np.float32)
    n = 420
    radii = np.clip(r.pareto(2.4, n) * 0.006 + 0.003, 0.003, 0.045) * D
    fresh = r.random(n) < 0.18
    for rad, cx, cy, f in zip(radii, r.random(n) * D, r.random(n) * D, fresh):
        ext = 3.2 if f else 1.6
        x0, x1 = int(max(cx - rad * ext, 0)), int(min(cx + rad * ext, D))
        y0, y1 = int(max(cy - rad * ext, 0)), int(min(cy + rad * ext, D))
        if x1 <= x0 or y1 <= y0: continue
        yy, xx = np.mgrid[y0:y1, x0:x1]
        q = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / rad
        bowl = -np.clip(1 - q * q, 0, 1) ** 1.3 * 0.8
        rim = np.exp(-((q - 1.0) / 0.3) ** 2) * 0.25
        h[y0:y1, x0:x1] += (bowl + rim) * (rad / D) * 34
        alb[y0:y1, x0:x1] += np.exp(-((q - 1.0) / 0.35) ** 2) * 0.35
        if f:  # fresh crater: a bright splash of ejecta around it
            alb[y0:y1, x0:x1] += np.exp(-(q / 2.2) ** 2) * 0.5
    h += (fbm(93, base=4, octaves=3) - 0.5) * 0.3  # dust
    return h, np.clip(alb, 0, 1)

def peach():
    """The original peach photo, skin pores smoothed away, the veins kept. PEACH_BANDS (0-1) keeps that much of
    the broad diagonal bands (1 = as photographed; lower reads less like a hand print). Soft seas, light dust."""
    keep = float(os.environ.get("PEACH_BANDS", "1"))
    detailed = np.asarray(_im.filter(ImageFilter.GaussianBlur(3.2 * K)), np.float32) * 1.1
    flat = np.asarray(_im.filter(ImageFilter.GaussianBlur(14 * K)), np.float32) * 1.1
    smooth = flat + (detailed - flat) * keep
    v = np.clip(soft(np.clip(LINES, 0, 1), 0.9) * 1.25, 0, 1)[..., None]
    vein_red = np.array((205, 108, 104))
    base = smooth * (1 - 0.42 * v) + vein_red * 0.42 * v
    m = fbm(92, base=90, octaves=4) + (fbm(94, base=200, octaves=1) - 0.5) * 0.25
    maria = soft(np.clip((m - 0.47) / 0.08, 0, 1), 3)
    dark = np.array((190, 118, 110))
    seas = float(os.environ.get("PEACH_SEAS", "0.3"))
    base = base * (1 - seas * maria[..., None]) + dark * seas * maria[..., None]
    dust = soft((fbm(93, base=4, octaves=3) - 0.5) * 0.3 * (1 - 0.6 * maria), 0.8)
    gy, gx = np.gradient(dust)
    light = 1 + np.clip(-(gx * -0.6 + gy * -0.8) * 0.9 * K, -0.08, 0.08)
    out = base * light[..., None]
    grey = out.mean(axis=2, keepdims=True)
    return out * 0.88 + grey * 0.12

def sky():
    """Dusky blue sky where the brand's veins become puffy cumulus clouds: cream on top, peach underneath, with
    a fine film grain, like a soft evening sky photo."""
    base = ramp([(0, (98, 140, 198)), (0.5, (128, 166, 214)), (0.85, (166, 194, 226)), (1, (190, 204, 224))], Y)
    veins = np.clip(LINES, 0, 1)
    # Billow the veins into clouds; layered noise gives cauliflower edges at every scale.
    mass = soft(veins, 9) * 3.6 + (fbm(71, base=30) - 0.5) * 0.8 + (fbm(72, base=10) - 0.5) * 0.32 + (fbm(75, base=3.5) - 0.5) * 0.16
    # A big warm cloud bank low in the sky, its top edge billowing.
    mass = mass + np.clip((Y - 0.74 - 0.32 * (fbm(74, base=40) - 0.5) - 0.06 * (fbm(76, base=8) - 0.5)) * 5, 0, 1.2)
    cloud = soft(np.clip((mass - 0.34) / 0.26, 0, 1), 0.9)
    # Light from above: bright cream tops with a silver edge; undersides and lower clouds catch peach.
    sh = int(10 * K)
    # Shift without wrapping round (np.roll would bring the top sky in under the bottom edge).
    def shifted(a, n):
        return np.concatenate([a[n:], np.repeat(a[-1:], n, axis=0)]) if n > 0 else np.concatenate([np.repeat(a[:1], -n, axis=0), a[:n]])
    below_empty = np.clip(cloud - soft(shifted(cloud, sh), 4), 0, 1)
    above_empty = np.clip(cloud - soft(shifted(cloud, -sh), 3), 0, 1)
    inner = soft(cloud, 6)
    cream, peach, shadow = np.array((253, 245, 233)), np.array((243, 178, 134)), np.array((214, 168, 150))
    warmth = np.clip(0.06 + 0.48 * Y + 0.75 * below_empty - 0.45 * above_empty, 0, 0.92)[..., None]
    col = cream * (1 - warmth) + peach * warmth
    # Soft self-shadow deep inside the bigger clouds, and billows catching light.
    deep = np.clip(inner - 0.75, 0, 1)[..., None] * 0.9
    col = col * (1 - 0.25 * deep) + shadow * 0.25 * deep
    # Billows: rounded puffs inside each cloud, lit on their upper sides.
    puffs = soft(fbm(78, base=24, octaves=2), 2)
    puff_light = np.clip((puffs - shifted(puffs, -int(5 * K))) * 8, -1, 1)
    col = col + 10 * soft(fbm(73, base=16, octaves=3), 1.5)[..., None] - 5 + 14 * above_empty[..., None] + 10 * puff_light[..., None] * inner[..., None]
    out = base * (1 - cloud[..., None]) + col * cloud[..., None]
    # Film grain, sized like a photo's, not one pixel wide at large sizes.
    g = Image.fromarray(((np.random.default_rng(77).random((D, D))) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.45 * K))
    grain = (np.asarray(g, np.float32) / 255 - 0.5) * (11 * max(1, K) ** 0.5)
    return out + grain[..., None]

def sunset():
    base = ramp([(0, (92, 52, 140)), (0.4, (196, 80, 140)), (0.7, (248, 128, 104)), (1, (255, 196, 110))], Y)
    return recolour(base, (110, 24, 70))

def ocean():
    base = ramp([(0, (14, 76, 110)), (0.55, (28, 140, 156)), (1, (126, 214, 204))], Y)
    return recolour(base, (6, 46, 70))

def matcha():
    base = ramp([(0, (162, 194, 132)), (1, (112, 156, 98))], Y)
    return recolour(base, (56, 92, 50))

def aurora():
    base = ramp([(0, (14, 18, 52)), (0.4, (40, 120, 120)), (0.55, (90, 70, 170)), (1, (18, 24, 66))], Y + 0.06 * np.sin(X * 6))
    return recolour(base, (150, 240, 200), 0.5)

def candy():
    base = ramp([(0, (255, 196, 222)), (0.5, (226, 200, 255)), (1, (176, 216, 255))], X * 0.6 + Y * 0.4)
    return recolour(base, (214, 96, 150), 0.5)

def _veins(thresh=0.1, width=0.8):
    """The brand veins as clean, flowing strokes: smoothed well past the photo's pixels, then given a crisp edge."""
    raw = soft(np.clip(LINES, 0, 1), 1.5)
    t = np.clip((raw - (0.06 + thresh * 0.5)) / 0.3, 0, 1)
    return t * t * (3 - 2 * t)

def sample(a, sx, sy):
    """Bilinear lookup of a 2-D map at fractional pixel positions."""
    sx = np.clip(sx, 0, D - 1.001); sy = np.clip(sy, 0, D - 1.001)
    x0 = sx.astype(int); y0 = sy.astype(int); fx = sx - x0; fy = sy - y0
    return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy) + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy)

def swirl(a, cx, cy, radius, turns):
    """Twists one region of a map: full twist at the centre, fading to none at the radius."""
    px, py = X * D, Y * D
    dx, dy = px - cx * D, py - cy * D
    r = np.sqrt(dx * dx + dy * dy) / (radius * D)
    ang = turns * np.clip(1 - r, 0, 1) ** 2
    c, s_ = np.cos(ang), np.sin(ang)
    return sample(a, cx * D + dx * c - dy * s_, cy * D + dx * s_ + dy * c)

NEON_SWIRL = (0.64, 0.27, 0.17, 1.2)  # the long diagonal vein upper right: centre x, y, radius, twist (radians)

def neon():
    """Black sphere, the veins glowing violet like neon; one vein twisted into a swirl."""
    base = ramp([(0, (30, 24, 40)), (1, (8, 6, 14))], Y * 0.7 + X * 0.3)
    v = swirl(_veins(0.08, 0.7), *NEON_SWIRL)
    glow = soft(swirl(_veins(0.05, 0.7), *NEON_SWIRL), 4)[..., None]
    v = v[..., None]
    out = base + np.array((150, 70, 255)) * 0.55 * glow
    return out * (1 - 0.85 * v) + np.array((214, 170, 255)) * 0.85 * v

def ultraviolet():
    """Deep purple gradient with black veins."""
    base = ramp([(0, (150, 96, 230)), (0.5, (98, 46, 180)), (1, (44, 14, 92))], Y * 0.75 + X * 0.25)
    v = _veins(0.1, 0.8)[..., None]
    return base * (1 - 0.8 * v) + np.array((14, 8, 24)) * 0.8 * v

def obsidian():
    """Glossy black with amethyst veins and a purple sheen."""
    base = ramp([(0, (44, 34, 58)), (0.45, (18, 14, 26)), (1, (6, 4, 10))], Y * 0.7 + X * 0.3)
    sheen = np.exp(-(((X - 0.3) / 0.35) ** 2 + ((Y - 0.25) / 0.25) ** 2))[..., None]
    base = base + np.array((120, 70, 190)) * 0.45 * sheen
    v = _veins(0.1, 0.8)[..., None]
    edge = np.clip(v - soft(_veins(0.1, 0.8), 1.5)[..., None], 0, 1)
    return base * (1 - 0.75 * v) + np.array((170, 110, 240)) * 0.75 * v + 60 * edge

def haze():
    """Purple fading to black from top to bottom, lilac veins."""
    base = ramp([(0, (176, 132, 236)), (0.45, (104, 58, 176)), (0.8, (36, 18, 64)), (1, (10, 6, 18))], Y)
    v = _veins(0.1, 0.8)[..., None]
    return base * (1 - 0.6 * v) + np.array((224, 196, 255)) * 0.6 * v

def neon_style(top, bottom, glow_top=None, glow_bottom=None, body=(30, 24, 40)):
    """Neon's look in any colour: a near-black body, the brand veins lit like neon tubing (colour may shift from
    top to bottom), a soft glow around them, and the same bent vein top right."""
    base = ramp([(0, body), (1, (8, 6, 14))], Y * 0.7 + X * 0.3)
    v = swirl(_veins(0.08, 0.7), *NEON_SWIRL)[..., None]
    glow = soft(swirl(_veins(0.05, 0.7), *NEON_SWIRL), 4)[..., None]
    t = Y[..., None]
    tube = np.array(top) * (1 - t) + np.array(bottom) * t
    g = np.array(glow_top or top) * (1 - t) + np.array(glow_bottom or bottom) * t
    out = base + g * 0.55 * glow
    return out * (1 - 0.85 * v) + tube * 0.85 * v

NEON_FAMILY = {
    "neon":        lambda: neon_style((214, 170, 255), (214, 170, 255), (150, 70, 255), (150, 70, 255)),
    "ultraviolet": lambda: neon_style((255, 150, 240), (196, 120, 255), (230, 60, 220), (140, 60, 255), body=(36, 20, 42)),
    "obsidian":    lambda: neon_style((244, 238, 255), (200, 190, 230), (180, 160, 230), (120, 100, 190), body=(26, 24, 32)),
    "haze":        lambda: neon_style((232, 200, 255), (255, 170, 214), (170, 110, 255), (255, 90, 170)),
    "sky":         lambda: neon_style((160, 210, 255), (255, 196, 160), (80, 150, 255), (255, 140, 90), body=(20, 26, 44)),
    "sunset":      lambda: neon_style((255, 214, 140), (255, 150, 90), (255, 170, 40), (255, 90, 40), body=(38, 24, 22)),
    "ocean":       lambda: neon_style((150, 255, 236), (110, 220, 255), (20, 230, 200), (20, 160, 255), body=(16, 30, 36)),
    "matcha":      lambda: neon_style((214, 255, 150), (170, 240, 120), (150, 255, 60), (90, 220, 60), body=(22, 32, 20)),
    "aurora":      lambda: neon_style((150, 255, 200), (200, 150, 255), (40, 255, 160), (150, 70, 255), body=(14, 22, 40)),
    "candy":       lambda: neon_style((255, 180, 222), (170, 214, 255), (255, 100, 190), (90, 170, 255), body=(34, 24, 38)),
}

VIBES = {"neon": neon, "ultraviolet": ultraviolet, "obsidian": obsidian, "haze": haze, "peach": peach, "sky": sky, "sunset": sunset, "ocean": ocean, "matcha": matcha, "aurora": aurora, "candy": candy}
LIGHT_EYES = set(NEON_FAMILY)

def body(tex):
    t = Image.fromarray(np.clip(tex, 0, 255).astype(np.uint8))
    dx, dy = X * 2 - 1, Y * 2 - 1
    d = np.sqrt(dx * dx + dy * dy); nz = np.sqrt(np.clip(1 - d * d, 0, 1))
    lam = np.clip(-0.45 * dx - 0.55 * dy + 0.7 * nz, 0, None)
    light = np.clip(190 + 65 * lam - 22 * d ** 4, 0, 255).astype(np.uint8)
    shaded = ImageChops.multiply(t, Image.merge("RGB", (Image.fromarray(light),) * 3))
    shaded = Image.blend(t, shaded, 0.32)
    mask = Image.new("L", (D * 4, D * 4)); ImageDraw.Draw(mask).ellipse((0, 0, D * 4 - 1, D * 4 - 1), fill=255)
    b = shaded.convert("RGBA"); b.putalpha(mask.resize((D, D), Image.LANCZOS)); return b, t

ONLY = sys.argv[4].split(",") if len(sys.argv) > 4 else None
VIBES.update(NEON_FAMILY)
for name, fn in VIBES.items():
    if ONLY and name not in ONLY: continue
    tex = fn(); b, t = body(tex)
    avg = t.resize((1, 1), Image.LANCZOS).getpixel((0, 0))
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    PRINT = os.environ.get("PRINT") == "1"
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if not PRINT: ImageDraw.Draw(glow).ellipse((CX - R - 6 * K, CY - R - 2 * K, CX + R + 6 * K, CY + R + 10 * K), fill=(*[int(v * 0.6 + 255 * 0.4) for v in avg], 140))
    canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(16 * K)))
    canvas.alpha_composite(b, (CX - R, CY - R))
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse((CX - 82 * K, CY - 96 * K, CX - 18 * K, CY - 52 * K), fill=(255, 255, 255, 85))
    canvas = Image.alpha_composite(canvas, hl.filter(ImageFilter.GaussianBlur(9 * K)))
    eyes = Image.new("RGBA", (S * 4, S * 4), (0, 0, 0, 0)); dr = ImageDraw.Draw(eyes); q = 4 * K
    iris, shine = ((246, 238, 228, 255), (40, 40, 70, 230)) if name in LIGHT_EYES else ((74, 40, 34, 255), (255, 255, 255, 235))
    for ex in (135, 185):
        dr.ellipse(((ex - 10) * q, (153 - 16) * q, (ex + 10) * q, (153 + 16) * q), fill=iris)
        dr.ellipse(((ex - 5) * q, (153 - 11) * q, (ex + 1) * q, (153 - 3) * q), fill=shine)
    canvas = Image.alpha_composite(canvas, eyes.resize((S, S), Image.LANCZOS))
    if PRINT:
        edge = Image.new("L", (S * 4, S * 4)); ImageDraw.Draw(edge).ellipse(((CX - R) * 4, (CY - R) * 4, (CX + R) * 4 - 1, (CY + R) * 4 - 1), fill=255)
        canvas.putalpha(ImageChops.multiply(canvas.getchannel("A"), edge.resize((S, S), Image.LANCZOS)))
    canvas.save(f"{out}/blob-{name}{'-print' if PRINT else ''}.png", optimize=True)
    if os.environ.get("MASK") == "1":
        # The veins alone, for animating light along them: white with the vein strength as alpha.
        vm = swirl(_veins(0.08, 0.7), *NEON_SWIRL) if name in NEON_FAMILY else _veins(0.1, 0.8)
        m = Image.new("L", (S, S), 0)
        m.paste(Image.fromarray((np.clip(vm, 0, 1) * 255).astype(np.uint8)), (CX - R, CY - R))
        circle = Image.new("L", (S * 4, S * 4)); ImageDraw.Draw(circle).ellipse(((CX - R) * 4, (CY - R) * 4, (CX + R) * 4 - 1, (CY + R) * 4 - 1), fill=255)
        m = ImageChops.multiply(m, circle.resize((S, S), Image.LANCZOS))
        eyes_off = Image.new("L", (S, S), 255); de = ImageDraw.Draw(eyes_off)
        for ex in (135, 185):
            de.ellipse(((ex - 15) * K, (153 - 21) * K, (ex + 15) * K, (153 + 21) * K), fill=0)
        m = ImageChops.multiply(m, eyes_off.filter(ImageFilter.GaussianBlur(3 * K)))
        white = Image.new("RGBA", (S, S), (255, 255, 255, 0)); white.putalpha(m)
        white.save(f"{out}/mask-{name}.png", optimize=True)
    print(name)
