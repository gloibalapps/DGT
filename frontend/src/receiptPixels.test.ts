import assert from "node:assert/strict";
import test from "node:test";
import { ahashLuma, bytesFromBase64, decodePng, dhashLuma, lumaFromRgba, perceptualFromLuma, sha256Hex } from "./receiptPixels.ts";

test("dHash and aHash match the Python implementation on a fixed grid", () => {
  const width = 32;
  const height = 32;
  const luma: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) luma.push((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 255 : 0);
  }
  assert.equal(dhashLuma(luma, width, height), "b54ab54ab54ab54a");
  assert.equal(ahashLuma(luma, width, height), "aa55aa55aa55aa55");
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAhUlEQVR4nGPk0ghgwAAfLizAFKQPYBooi3GBUQcRAiz4paVkVGhn97MndzAFB10IjTqIEBh1ECEw6BxEINtjzZk0BYMuhEYdRAgMOgfRti4jI08MuhAadRAhMOogQmDQOWjQ1WUEHCRgkEAXZyB6goMuykYdRAiMOogQGHQOIpDt6T8uAwDRBBPaGMDliQAAAABJRU5ErkJggg==";

test("a phone-decoded PNG matches the server perceptual hash", async () => {
  const bytes = bytesFromBase64(PNG);
  const image = decodePng(bytes);
  assert.ok(image);
  const hashed = perceptualFromLuma(lumaFromRgba(image.rgba, image.width, image.height), image.width, image.height);
  assert.equal(await sha256Hex(bytes), "4c779fe475d65de4fcd7f50b5c9922752f5bed0b4bab339802042d365045b0be");
  assert.equal(hashed.dhash, "0040400040404040");
  assert.equal(hashed.ahash, "7f41417f47474141");
});

test("sha256 is the hash of the image bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(
    await sha256Hex(bytes),
    "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  );
});
