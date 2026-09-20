import asyncio, os
from dotenv import load_dotenv
from emergentintegrations.llm.openai.image_generation import OpenAIImageGeneration

load_dotenv()
KEY = os.environ.get("EMERGENT_LLM_KEY")
OUT = "/app/frontend/assets/logo_options"
os.makedirs(OUT, exist_ok=True)

GREEN = "emerald green #10B981 with a brighter mint highlight #34D399"

PROMPTS = {
    "route_pin": (
        f"A modern, flat, minimal logo mark on a fully transparent background. Concept: a "
        f"smooth winding road/route ribbon that curves upward and ends in a rounded map location "
        f"pin at the top; a small dollar sign ($) sits subtly inside the pin. Colour: {GREEN}. "
        f"Clean geometric vector, bold rounded shapes, balanced, centered, no text, no letters, "
        f"crisp app-icon style, professional fintech aesthetic."
    ),
    "coin_route": (
        f"A modern flat minimal logo mark on a fully transparent background. Concept: a round "
        f"coin seen face-on with a winding dashed road crossing over it diagonally and a dollar "
        f"sign ($) on the coin, blending money and mileage. Colour: {GREEN}. Simple bold vector, "
        f"single accent colour, generous negative space, centered, no text, crisp modern flat "
        f"design, app-icon ready."
    ),
    "gt_route": (
        f"A modern minimal geometric monogram of the letters 'G' and 'T' combined into one clean "
        f"mark, where a subtle road with a dashed centre line forms part of the letterforms. Fully "
        f"transparent background. Colour: {GREEN}. Bold, simple, single-weight vector, balanced, "
        f"centered, crisp flat design, professional fintech app-icon aesthetic."
    ),
}

async def main():
    gen = OpenAIImageGeneration(api_key=KEY)
    for name, prompt in PROMPTS.items():
        print("generating", name, flush=True)
        imgs = await gen.generate_images(prompt=prompt, model="gpt-image-1", number_of_images=1)
        with open(os.path.join(OUT, f"{name}.png"), "wb") as f:
            f.write(imgs[0])
        print("saved", name, len(imgs[0]), "bytes", flush=True)

asyncio.run(main())
