/** Python cryptography.Fernet (AES-128-CBC + HMAC-SHA256, version 0x80). */

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function copyBytes(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(raw.byteLength);
  out.set(raw);
  return out;
}

async function importKey(raw: Uint8Array, usage: "encrypt" | "sign"): Promise<CryptoKey> {
  const bytes = copyBytes(raw);
  if (usage === "encrypt") {
    return await crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
  }
  return await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function fernetEncrypt(keyB64: string, plaintext: string): Promise<string> {
  const key = b64urlToBytes(keyB64);
  if (key.length !== 32) throw new Error("Fernet key must be 32 bytes");
  const signing = key.slice(0, 16);
  const encryption = key.slice(16);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ts = new Uint8Array(8);
  const sec = Math.floor(Date.now() / 1000);
  const view = new DataView(ts.buffer);
  view.setUint32(0, Math.floor(sec / 2 ** 32));
  view.setUint32(4, sec >>> 0);
  const aes = await importKey(encryption, "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: copyBytes(iv) }, aes, new TextEncoder().encode(plaintext)));
  const version = new Uint8Array([0x80]);
  const head = concat(version, ts, iv, ct);
  const macKey = await importKey(signing, "sign");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, copyBytes(head)));
  return bytesToB64url(concat(head, mac));
}

export async function fernetDecrypt(keyB64: string, token: string): Promise<string> {
  const key = b64urlToBytes(keyB64);
  if (key.length !== 32) throw new Error("Fernet key must be 32 bytes");
  const raw = b64urlToBytes(token);
  if (raw.length < 1 + 8 + 16 + 32 || raw[0] !== 0x80) throw new Error("bad fernet token");
  const signing = key.slice(0, 16);
  const encryption = key.slice(16);
  const mac = raw.slice(raw.length - 32);
  const head = raw.slice(0, raw.length - 32);
  const macKey = await importKey(signing, "sign");
  const ok = await crypto.subtle.verify("HMAC", macKey, copyBytes(mac), copyBytes(head));
  if (!ok) throw new Error("fernet hmac mismatch");
  const iv = head.slice(9, 25);
  const ct = head.slice(25);
  const aes = await importKey(encryption, "encrypt");
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: copyBytes(iv) }, aes, copyBytes(ct));
  return new TextDecoder().decode(pt);
}
