import { decode as decodeJpeg } from "jpeg-js";

import {
  bytesFromBase64, lumaFromRgba, perceptualFromLuma, sha256Hex, type Perceptual, decodePng,
} from "./receiptPixels";

export interface ReceiptHashes extends Perceptual {
  sha256: string;
}

export function decodeImage(bytes: Uint8Array): { rgba: Uint8Array; width: number; height: number } | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    try {
      const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
      return { rgba: decoded.data, width: decoded.width, height: decoded.height };
    } catch {
      return null;
    }
  }
  return decodePng(bytes);
}

export async function hashReceipt(base64: string): Promise<ReceiptHashes> {
  const bytes = bytesFromBase64(base64);
  const sha256 = await sha256Hex(bytes);
  const image = decodeImage(bytes);
  if (!image || image.width < 8 || image.height < 8) {
    return { sha256, dhash: "", ahash: "", dhashRots: [], ahashRots: [] };
  }
  const luma = lumaFromRgba(image.rgba, image.width, image.height);
  const perceptual = perceptualFromLuma(luma, image.width, image.height);
  return { sha256, ...perceptual };
}
