from PIL import Image, ImageDraw

SRC = "navy_wheel_dollar.png"   # cleanest steering-wheel + $ mark (transparent bg)
NAVY = (10, 20, 32, 255)        # #0A1420

def trim(im):
    bbox = im.split()[3].getbbox()
    return im.crop(bbox) if bbox else im

mark = trim(Image.open(SRC).convert("RGBA"))

# --- App icon: navy rounded square + centred mark ---
S = 1024
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
radius = int(S * 0.22)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S, S], radius=radius, fill=255)
bg = Image.new("RGBA", (S, S), NAVY)
icon.paste(bg, (0, 0), mask)

# scale mark to ~64% of icon, centre it
target = int(S * 0.64)
w, h = mark.size
scale = target / max(w, h)
mark_r = mark.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
mx = (S - mark_r.width) // 2
my = (S - mark_r.height) // 2
icon.alpha_composite(mark_r, (mx, my))
icon.save("gigtax_icon_navy.png")
print("saved gigtax_icon_navy.png", icon.size)

# --- Transparent mark on its own (for use over any background) ---
mark.save("gigtax_mark_transparent.png")
print("saved gigtax_mark_transparent.png", mark.size)

# --- White-background version (for stores that require opaque, e.g. some listings) ---
white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
mk = mark.resize((int(mark.width * (int(S*0.7)/max(mark.size))), int(mark.height * (int(S*0.7)/max(mark.size)))), Image.LANCZOS)
white.alpha_composite(mk, ((S - mk.width)//2, (S - mk.height)//2))
white.convert("RGB").save("gigtax_icon_white.png")
print("saved gigtax_icon_white.png")
