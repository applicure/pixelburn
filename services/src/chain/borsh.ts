import bs58 from "bs58";

/** Minimal borsh reader for the handful of types the program uses. */
export class BorshReader {
  private o = 0;
  constructor(private readonly buf: Uint8Array) {}
  get offset() {
    return this.o;
  }
  get remaining() {
    return this.buf.length - this.o;
  }
  private take(n: number): Uint8Array {
    if (this.o + n > this.buf.length) throw new RangeError(`borsh: read past end (${this.o}+${n} > ${this.buf.length})`);
    const s = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  private le(n: number): bigint {
    const b = this.take(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }
  u8() {
    return this.take(1)[0]!;
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    return Number(this.le(2));
  }
  u32() {
    return Number(this.le(4));
  }
  u64() {
    return this.le(8);
  }
  i64() {
    const v = this.le(8);
    return v >= 1n << 63n ? v - (1n << 64n) : v;
  }
  u128() {
    return this.le(16);
  }
  bytes(n: number) {
    return Uint8Array.from(this.take(n));
  }
  pubkey() {
    return bs58.encode(this.take(32));
  }
  string() {
    const len = this.u32();
    return new TextDecoder().decode(this.take(len));
  }
  vec<T>(item: () => T): T[] {
    const len = this.u32();
    return Array.from({ length: len }, item);
  }
  option<T>(item: () => T): T | null {
    return this.u8() === 1 ? item() : null;
  }
}

/** Minimal writer, used by tests and the seed script to produce realistic event payloads. */
export class BorshWriter {
  private parts: number[] = [];
  private le(v: bigint, n: number) {
    let x = BigInt.asUintN(n * 8, v);
    for (let i = 0; i < n; i++) {
      this.parts.push(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }
  raw(b: Uint8Array) {
    this.parts.push(...b);
    return this;
  }
  u8(v: number) {
    return this.le(BigInt(v), 1);
  }
  u16(v: number) {
    return this.le(BigInt(v), 2);
  }
  u32(v: number) {
    return this.le(BigInt(v), 4);
  }
  u64(v: bigint) {
    return this.le(v, 8);
  }
  i64(v: bigint) {
    return this.le(v, 8);
  }
  u128(v: bigint) {
    return this.le(v, 16);
  }
  pubkey(b58: string) {
    return this.raw(bs58.decode(b58));
  }
  string(s: string) {
    const b = new TextEncoder().encode(s);
    return this.u32(b.length).raw(b);
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}
