import asyncio, os
from dotenv import load_dotenv
from emergentintegrations.llm.openai.image_generation import OpenAIImageGeneration

load_dotenv()
KEY = os.environ.get("EMERGENT_LLM_KEY")

OUT = "/app/frontend/assets/logo_options"
os.makedirs(OUT, exist_ok=True)

PROMPTS = {
    "wheel_dollar_a": (
        "A modern, flat, minimal app icon logo for 'GigTax', a tax app for gig-economy "
        "drivers. Central symbol: a simplified car steering wheel with a dollar sign ($) "
        "integrated at its center hub. Deep navy background color #0A1420, symbol in a "
        "bright sky-blue accent #38BDF8 with subtle lighter cyan highlights. Clean geometric "
        "vector style, thick rounded strokes, high contrast, perfectly centered, rounded-square "
        "app icon, generous padding, no text, no letters, crisp flat design, professional "
        "fintech aesthetic."
    ),
    "wheel_dollar_b": (
        "A modern flat minimal logo mark for a gig-driver tax app called GigTax. Concept: a "
        "steering wheel whose central hub forms a dollar sign, with a tiny road/receipt hint. "
        "Monochromatic sky-blue (#38BDF8) mark on a solid deep-navy (#0A1420) rounded square "
        "background. Bold, simple, single-weight line-and-fill vector, balanced negative space, "
        "centered, no text, app-icon ready, sharp and clean."
    ),
}

async def main():
    gen = OpenAIImageGeneration(api_key=KEY)
    for name, prompt in PROMPTS.items():
        print("generating", name, flush=True)
        imgs = await gen.generate_images(prompt=prompt, model="gpt-image-1", number_of_images=1)
        path = os.path.join(OUT, f"{name}.png")
        with open(path, "wb") as f:
            f.write(imgs[0])
        print("saved", path, len(imgs[0]), "bytes", flush=True)

asyncio.run(main())
