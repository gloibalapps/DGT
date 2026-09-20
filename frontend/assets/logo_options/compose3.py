from PIL import Image, ImageDraw

OPT = "/app/frontend/assets/logo_options"
IMG = "/app/frontend/assets/images"
NAVY = (10, 20, 32, 255)  # #0A1420

def trim(im):
    b = im.split()[3].getbbox()
    return im.crop(b) if b else im

mark = trim(Image.open(f"{OPT}/coin_mark_dark.png").convert("RGBA"))   # blue mark, transparent

def rounded_tile(size, bg, mrk, scale=0.60, radius_frac=0.22):
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=int(size * radius_frac), fill=255)
    icon.paste(Image.new("RGBA", (size, size), bg), (0, 0), mask)
    t = int(size * scale); sc = t / max(mrk.size)
    mr = mrk.resize((int(mrk.width * sc), int(mrk.height * sc)), Image.LANCZOS)
    icon.alpha_composite(mr, ((size - mr.width) // 2, (size - mr.height) // 2))
    return icon

def full_square(size, bg, mrk, scale=0.62):
    icon = Image.new("RGBA", (size, size), bg)
    t = int(size * scale); sc = t / max(mrk.size)
    mr = mrk.resize((int(mrk.width * sc), int(mrk.height * sc)), Image.LANCZOS)
    icon.alpha_composite(mr, ((size - mr.width) // 2, (size - mr.height) // 2))
    return icon

def padded_mark(size, mrk, scale=0.58):
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    t = int(size * scale); sc = t / max(mrk.size)
    mr = mrk.resize((int(mrk.width * sc), int(mrk.height * sc)), Image.LANCZOS)
    canvas.alpha_composite(mr, ((size - mr.width) // 2, (size - mr.height) // 2))
    return canvas

# iOS / home-screen icon — opaque full navy square (iOS rounds it itself)
full_square(1024, NAVY, mark, 0.62).convert("RGB").save(f"{IMG}/icon.png")
# Android adaptive foreground — transparent, mark in the safe zone (bg set in app.json)
padded_mark(1024, mark, 0.56).save(f"{IMG}/adaptive-icon.png")
# Web favicon — rounded navy tile
rounded_tile(256, NAVY, mark, 0.60).save(f"{IMG}/favicon.png")
# Splash — transparent mark, shown centred on the navy splash background
padded_mark(1024, mark, 0.82).save(f"{IMG}/splash-image.png")
# Login wordmarks (dark = light text for dark bg, light = navy text for light bg)
trim(Image.open(f"{OPT}/wordmark_dark.png").convert("RGBA")).save(f"{IMG}/logo-dark.png")
trim(Image.open(f"{OPT}/wordmark_light.png").convert("RGBA")).save(f"{IMG}/logo-wordmark-light.png")
# Settings 40x40 badge — small rounded app icon
rounded_tile(256, NAVY, mark, 0.60).save(f"{IMG}/logo-light.png")
print("all app assets written")
