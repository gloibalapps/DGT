import asyncio, os
from dotenv import load_dotenv
from emergentintegrations.llm.openai.image_generation import OpenAIImageGeneration

load_dotenv()
KEY = os.environ.get("EMERGENT_LLM_KEY")
OUT = "/app/frontend/assets/logo_options"
os.makedirs(OUT, exist_ok=True)

PROMPTS = {
    "navy_wheel_dollar": (
        "App icon. The ENTIRE square canvas is filled edge to edge with a solid deep navy "
        "color #0A1420 (absolutely no white background, no border, navy fills every corner). "
        "Centered on the navy is a modern flat minimal symbol: a simplified car steering wheel "
        "whose center hub is a dollar sign ($). The symbol is bright sky-blue #38BDF8 with soft "
        "cyan glow. Clean geometric vector, thick rounded strokes, high contrast against navy, "
        "generous padding, no text, no letters, professional fintech app-icon aesthetic."
    ),
    "navy_wheel_road": (
        "App icon, square, completely filled edge-to-edge with solid deep navy #0A1420 "
        "(no white anywhere). Center: a minimal flat steering wheel in sky-blue #38BDF8, its "
        "hub forming a dollar sign, and a small stylized road with a dashed centre line running "
        "downward from the wheel (hinting at mileage). Single accent colour on navy, bold simple "
        "vector, balanced negative space, centered, no text, crisp modern flat design."
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
