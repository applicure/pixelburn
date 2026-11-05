import { readFile } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { BLOCK_PX, MAX_LINK, MAX_TITLE, MAX_UPLOAD_BYTES } from "../constants.js";
import { sha256Hex } from "../uploads/process.js";
import { localFileName } from "../uploads/storage.js";
import { validateAdContent } from "@mpb/sdk";
import type { Logger } from "../lib/log.js";

// ---------- pluggable hooks ----------

export interface DomainBlocklist {
  isBlocked(host: string): boolean;
}

/** Known wallet-drainer domains. Default: file + optional remote list refreshed periodically. */
export interface DrainerList {
  isDrainer(host: string): Promise<boolean>;
}

export interface NsfwChecker {
  /** Return { nsfw: true, score, label } to reject. */
  check(image: Buffer, contentType: string): Promise<{ nsfw: boolean; score?: number; label?: string }>;
}

export const noopNsfw: NsfwChecker = { check: async () => ({ nsfw: false }) };

export interface ImageFetcher {
  fetch(url: string, maxBytes: number): Promise<Buffer>;
}

/** host matches entry exactly or is a subdomain of it */
export function hostMatches(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ""), e = entry.toLowerCase().replace(/^\*\./, "");
  return h === e || h.endsWith(`.${e}`);
}

export function parseDomainList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

export class SetBlocklist implements DomainBlocklist {
  constructor(private readonly entries: string[]) {}
  isBlocked(host: string) {
    return this.entries.some((e) => hostMatches(host, e));
  }
  static async fromFile(file: string): Promise<SetBlocklist> {
    const txt = await readFile(file, "utf8").catch(() => "");
    return new SetBlocklist(parseDomainList(txt));
  }
}

export class FileAndUrlDrainerList implements DrainerList {
  private remote: string[] = [];
  private fetchedAt = 0;
  constructor(
    private readonly local: string[],
    private readonly url: string | undefined,
    private readonly log: Logger,
    private readonly ttlMs = 30 * 60_000,
  ) {}
  static async create(file: string, url: string | undefined, log: Logger) {
    const txt = await readFile(file, "utf8").catch(() => "");
    return new FileAndUrlDrainerList(parseDomainList(txt), url, log);
  }
  private async refresh() {
    if (!this.url || Date.now() - this.fetchedAt < this.ttlMs) return;
    this.fetchedAt = Date.now();
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      // Accept either newline-separated domains or a JSON array of domains.
      this.remote = body.trim().startsWith("[") ? (JSON.parse(body) as string[]) : parseDomainList(body);
    } catch (e) {
      this.log.warn(`drainer list refresh failed: ${(e as Error).message}`);
    }
  }
  async isDrainer(host: string) {
    await this.refresh();
    return [...this.local, ...this.remote].some((e) => hostMatches(host, e));
  }
}

/** HTTP fetch limited to allowlisted hosts, with timeout and byte cap. */
export class HttpImageFetcher implements ImageFetcher {
  constructor(private readonly allowedHosts: string[]) {}
  async fetch(url: string, maxBytes: number): Promise<Buffer> {
    let u = new URL(url);
    let res: Response | undefined;
    // Follow redirects manually so every hop is checked against the allowlist (SSRF guard).
    for (let hop = 0; hop < 4; hop++) {
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`image host not allowed: ${u.protocol}`);
      if (!this.allowedHosts.some((h) => hostMatches(u.host, h) || hostMatches(u.hostname, h))) {
        throw new Error(`image host not allowed: ${u.host}`);
      }
      res = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        u = new URL(loc, u);
        res = undefined;
        continue;
      }
      break;
    }
    if (!res) throw new Error("image fetch: too many redirects");
    if (!res.ok || !res.body) throw new Error(`image fetch HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) throw new Error(`image too large (${len} bytes)`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += c.length;
      if (total > maxBytes) throw new Error(`image too large (> ${maxBytes} bytes)`);
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
}

/** Serves our own /files/ URLs from disk, everything else via the wrapped fetcher. */
export class LocalFirstFetcher implements ImageFetcher {
  constructor(
    private readonly publicBaseUrl: string,
    private readonly readLocal: (name: string) => Promise<Buffer | null>,
    private readonly inner: ImageFetcher,
    private readonly aliases: readonly string[] = [],
  ) {}
  async fetch(url: string, maxBytes: number): Promise<Buffer> {
    const name = localFileName(url, this.publicBaseUrl, this.aliases);
    if (name) {
      const b = await this.readLocal(name);
      if (!b) throw new Error("local file missing");
      if (b.length > maxBytes) throw new Error(`image too large (${b.length} bytes)`);
      return b;
    }
    return this.inner.fetch(url, maxBytes);
  }
}

// ---------- checks ----------

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ModerationOutcome {
  /** A definitive policy/integrity failure -> auto-reject. */
  reject: boolean;
  /** A transient failure (e.g. image not yet propagated) -> retry later. */
  retry: boolean;
  reason: string | null;
  results: CheckResult[];
}

export interface AdForChecks {
  title: string;
  link: string;
  imageUri: string;
  imageSha256: string;
  w: number;
  h: number;
}

export interface CheckDeps {
  blocklist: DomainBlocklist;
  drainers: DrainerList;
  nsfw: NsfwChecker;
  fetcher: ImageFetcher;
  resolveImageUrl: (uri: string) => string;
  maxBytes?: number;
}

export async function runChecks(ad: AdForChecks, d: CheckDeps): Promise<ModerationOutcome & { image?: Buffer }> {
  const results: CheckResult[] = [];
  const fail = (name: string, detail: string) => results.push({ name, ok: false, detail });
  const pass = (name: string, detail?: string) => results.push({ name, ok: true, ...(detail ? { detail } : {}) });

  // Same content rules the program enforces (printable-ASCII URLs, no control/format chars in title).
  // On-chain ads always pass; this guards content that reaches us by other paths.
  const contentErr = validateAdContent({ title: ad.title, link: ad.link, imageUri: ad.imageUri });
  if (contentErr) fail("content", contentErr);
  else pass("content");

  // Title
  if (ad.title.length === 0 || [...ad.title].length > MAX_TITLE) fail("title", `title must be 1..${MAX_TITLE} chars`);
  else pass("title");

  // Link
  let host: string | null = null;
  try {
    const u = new URL(ad.link);
    if (ad.link.length > MAX_LINK) fail("link", `link longer than ${MAX_LINK}`);
    else if (u.protocol !== "https:") fail("link", "link must be https");
    else if (u.username || u.password) fail("link", "credentials in link not allowed");
    else {
      host = u.hostname;
      pass("link");
    }
  } catch {
    fail("link", "invalid URL");
  }
  if (host) {
    if (d.blocklist.isBlocked(host)) fail("blocklist", `domain ${host} is blocklisted`);
    else pass("blocklist");
    if (await d.drainers.isDrainer(host)) fail("drainer", `domain ${host} is a known drainer`);
    else pass("drainer");
  }

  // Image
  let image: Buffer | undefined;
  let retry = false;
  if (!ad.imageUri) fail("image_fetch", "missing image_uri");
  else {
    try {
      image = await d.fetcher.fetch(d.resolveImageUrl(ad.imageUri), d.maxBytes ?? MAX_UPLOAD_BYTES);
      pass("image_fetch", `${image.length} bytes`);
    } catch (e) {
      const msg = (e as Error).message;
      // Not-allowed host / too large are policy failures; network errors are retryable.
      if (/not allowed|too large/.test(msg)) fail("image_fetch", msg);
      else {
        retry = true;
        results.push({ name: "image_fetch", ok: false, detail: `retryable: ${msg}` });
      }
    }
  }
  if (image) {
    if (image.length > (d.maxBytes ?? MAX_UPLOAD_BYTES)) fail("image_size", "image exceeds 5MB");
    else pass("image_size");
    const sha = sha256Hex(image);
    if (sha !== ad.imageSha256.toLowerCase()) fail("sha256", `sha256 mismatch: got ${sha}, on-chain ${ad.imageSha256}`);
    else pass("sha256");
    const ft = await fileTypeFromBuffer(image);
    if (!ft || !["image/png", "image/webp", "image/jpeg"].includes(ft.mime)) fail("image_type", `unsupported type ${ft?.mime ?? "unknown"}`);
    else {
      pass("image_type", ft.mime);
      try {
        const meta = await sharp(image).metadata();
        const ew = ad.w * BLOCK_PX, eh = ad.h * BLOCK_PX;
        if (meta.width !== ew || meta.height !== eh) fail("dimensions", `expected ${ew}x${eh}, got ${meta.width}x${meta.height}`);
        else pass("dimensions", `${ew}x${eh}`);
        const n = await d.nsfw.check(image, ft.mime);
        if (n.nsfw) fail("nsfw", `flagged${n.label ? `: ${n.label}` : ""}${n.score != null ? ` (${n.score})` : ""}`);
        else pass("nsfw");
      } catch (e) {
        fail("image_decode", (e as Error).message);
      }
    }
  }

  const hardFails = results.filter((r) => !r.ok && !r.detail?.startsWith("retryable"));
  return {
    reject: hardFails.length > 0,
    retry: retry && hardFails.length === 0,
    reason: hardFails.length ? hardFails.map((r) => `${r.name}: ${r.detail}`).join("; ") : null,
    results,
    image,
  };
}
