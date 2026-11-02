export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`bad hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** ceil(a / b) for non-negative bigints. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("division by zero");
  if (a < 0n) throw new RangeError("negative numerator");
  return (a + b - 1n) / b;
}

export const U64_MAX = (1n << 64n) - 1n;

export function assertU64(v: bigint, what = "value"): bigint {
  if (v < 0n || v > U64_MAX) throw new RangeError(`${what} does not fit u64`);
  return v;
}

export function base64ToBytes(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function bytesToBase64(b: Uint8Array): string {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
    return btoa(s);
  }
  return Buffer.from(b).toString("base64");
}
