from PIL import Image, ImageDraw, ImageFont

S = 1024
SRC = "coin_route.png"                      # chosen mark (transparent bg, line style)
FONT = "/app/frontend/assets/fonts/BarlowCondensed-Bold.ttf"

DARK_BG   = (10, 20, 32, 255)     # #0A1420
DARK_ACC  = (56, 189, 248, 255)   # #38BDF8
DARK_TXT  = (241, 245, 249, 255)  # #F1F5F9
LIGHT_BG  = (243, 246, 250, 255)  # #F3F6FA
LIGHT_ACC = (12, 127, 209, 255)   # #0C7FD1
LIGHT_TXT = (11, 37, 69, 255)     # #0B2545

def trim(im):
    b = im.split()[3].getbbox()
    return im.crop(b) if b else im

def recolor(mark, rgb):
    a = mark.split()[3]
    solid = Image.new("RGBA", mark.size, rgb[:3] + (0,))
    solid.putalpha(a)
    return solid

mark = trim(Image.open(SRC).convert("RGBA"))

def tile(bg, mrk, scale=0.60):
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S, S], radius=int(S * 0.22), fill=255)
    icon.paste(Image.new("RGBA", (S, S), bg), (0, 0), mask)
    t = int(S * scale); sc = t / max(mrk.size)
    mr = mrk.resize((int(mrk.width * sc), int(mrk.height * sc)), Image.LANCZOS)
    icon.alpha_composite(mr, ((S - mr.width) // 2, (S - mr.height) // 2))
    return icon

# --- Icons (light + dark) ---
tile(DARK_BG,  recolor(mark, DARK_ACC)).save("coin_icon_dark.png")
tile(LIGHT_BG, recolor(mark, LIGHT_ACC)).save("coin_icon_light.png")
recolor(mark, DARK_ACC).save("coin_mark_dark.png")
recolor(mark, LIGHT_ACC).save("coin_mark_light.png")
print("icons + marks saved")

# --- Wordmark: [mark] GigTax  (Gig in text colour, Tax in accent) ---
def wordmark(acc, txt, out, bg=None):
    mk = recolor(mark, acc)
    MH = 300
    sc = MH / max(mk.size)
    mk = mk.resize((int(mk.width * sc), int(mk.height * sc)), Image.LANCZOS)
    font = ImageFont.truetype(FONT, 300)
    g_w = font.getlength("Gig"); t_w = font.getlength("Tax")
    gap = 44
    pad = 40
    W = pad + mk.width + gap + int(g_w + t_w) + pad
    H = 400
    canvas = Image.new("RGBA", (W, H), bg if bg else (0, 0, 0, 0))
    # vertically centre the mark
    canvas.alpha_composite(mk, (pad, (H - mk.height) // 2))
    d = ImageDraw.Draw(canvas)
    # baseline-ish centring for text
    asc, desc = font.getmetrics()
    ty = (H - (asc + desc)) // 2
    tx = pad + mk.width + gap
    d.text((tx, ty), "Gig", font=font, fill=txt)
    d.text((tx + g_w, ty), "Tax", font=font, fill=acc)
    trimmed = trim(canvas) if bg is None else canvas
    trimmed.save(out)
    print("saved", out, trimmed.size)

wordmark(DARK_ACC,  DARK_TXT,  "wordmark_dark.png")
wordmark(LIGHT_ACC, LIGHT_TXT, "wordmark_light.png")
