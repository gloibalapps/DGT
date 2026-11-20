/**
 * 64-bit dHash and aHash. The arithmetic matches backend/receipt_dupes.py
 * (integer box filter, luma 0.299/0.587/0.114). JS bitwise ops are 32-bit,
 * so the 64 bits are packed as hex nibbles instead of a shift register.
 */
import { inflate } from "pako";

export function lumaFromRgba(rgba: Uint8Array, width: number, height: number): number[] {
  const out = new Array<number>(width * height);
  let i = 0;
  for (let p = 0; p < width * height; p++) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    out[p] = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
    i += 4;
  }
  return out;
}

export function lumaFromRgb(rgb: Uint8Array, width: number, height: number): number[] {
  const out = new Array<number>(width * height);
  let i = 0;
  for (let p = 0; p < width * height; p++) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    out[p] = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
    i += 3;
  }
  return out;
}

export function resizeBox(luma: number[], width: number, height: number, tw: number, th: number): number[] {
  const out = new Array<number>(tw * th);
  let n = 0;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * height) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * width) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / tw));
      let acc = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx++) {
          acc += luma[row + xx];
          count += 1;
        }
      }
      out[n] = Math.floor(acc / count);
      n += 1;
    }
  }
  return out;
}

export function rot90(luma: number[], width: number, height: number): { luma: number[]; width: number; height: number } {
  const nw = height;
  const out = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = height - 1 - y;
      const ny = x;
      out[ny * nw + nx] = luma[y * width + x];
    }
  }
  return { luma: out, width: nw, height: width };
}

function bitsToHex(bits: number[]): string {
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let n = 0;
    for (let b = 0; b < 4; b++) n = (n << 1) | (bits[i + b] ? 1 : 0);
    hex += n.toString(16);
  }
  return hex;
}

export function dhashLuma(luma: number[], width: number, height: number): string {
  const small = resizeBox(luma, width, height, 9, 8);
  const bits: number[] = [];
  for (let row = 0; row < 8; row++) {
    const base = row * 9;
    for (let col = 0; col < 8; col++) bits.push(small[base + col] > small[base + col + 1] ? 1 : 0);
  }
  return bitsToHex(bits);
}

export function ahashLuma(luma: number[], width: number, height: number): string {
  const small = resizeBox(luma, width, height, 8, 8);
  let sum = 0;
  for (const p of small) sum += p;
  const avg = Math.floor(sum / 64);
  const bits = small.map((p) => (p > avg ? 1 : 0));
  return bitsToHex(bits);
}

export interface Perceptual {
  dhash: string;
  ahash: string;
  dhashRots: string[];
  ahashRots: string[];
}

export function perceptualFromLuma(luma: number[], width: number, height: number): Perceptual {
  const dhashRots: string[] = [];
  const ahashRots: string[] = [];
  let cur = luma;
  let w = width;
  let h = height;
  for (let i = 0; i < 4; i++) {
    dhashRots.push(dhashLuma(cur, w, h));
    ahashRots.push(ahashLuma(cur, w, h));
    const next = rot90(cur, w, h);
    cur = next.luma;
    w = next.width;
    h = next.height;
  }
  return { dhash: dhashRots[0], ahash: ahashRots[0], dhashRots, ahashRots };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 8-bit non-interlaced PNG, colour types RGB and RGBA. */
export function decodePng(bytes: Uint8Array): { rgba: Uint8Array; width: number; height: number } | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) return null;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (offset + 12 + length > bytes.length) return null;
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      interlace = bytes[offset + 20];
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6) || width < 1 || height < 1) return null;
  const bpp = colorType === 2 ? 3 : 4;
  const packed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of idat) { packed.set(chunk, at); at += chunk.length; }
  const inflated = inflate(packed);
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src];
    src += 1;
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const raw = inflated[src + i];
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let value = raw;
      if (filter === 1) value = (raw + left) & 255;
      else if (filter === 2) value = (raw + up) & 255;
      else if (filter === 3) value = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (raw + paeth(left, up, ul)) & 255;
      row[i] = value;
    }
    src += stride;
    prev = row;
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      rgba[d] = row[s];
      rgba[d + 1] = row[s + 1];
      rgba[d + 2] = row[s + 2];
      rgba[d + 3] = bpp === 4 ? row[s + 3] : 255;
    }
  }
  return { rgba, width, height };
}

export function bytesFromBase64(value: string): Uint8Array {
  const clean = value.includes(",") ? value.split(",")[1] : value.replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new Uint8Array(bytes));
    return toHex(new Uint8Array(digest));
  }
  const Crypto = await import("expo-crypto");
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
  return toHex(new Uint8Array(digest));
}
