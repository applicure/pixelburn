import { describe, expect, it } from "vitest";
import {
  HttpImageFetcher,
  hostMatches,
  noopNsfw,
  runChecks,
  SetBlocklist,
  type CheckDeps,
  type ImageFetcher,
} from "../src/moderation/checks.js";
import { generatePixelArt } from "../src/lib/pixelart.js";
import { sha256Hex } from "../src/uploads/process.js";

const drainers = { isDrainer: async (h: string) => hostMatches(h, "drainer.invalid") };
const deps = (image: Buffer | Error, extra: Partial<CheckDeps> = {}): CheckDeps => ({
  blocklist: new SetBlocklist(["bit.ly", "evil.example"]),
  drainers,
  nsfw: noopNsfw,
  fetcher: { fetch: async () => { if (image instanceof Error) throw image; return image; } } satisfies ImageFetcher,
  resolveImageUrl: (u) => u,
  ...extra,
});

const img = await generatePixelArt(3, 2, 42); // 30x20
const good = { title: "Hello", link: "https://ok.example/path", imageUri: "https://arweave.net/x", imageSha256: sha256Hex(img), w: 3, h: 2 };

describe("moderation checks", () => {
  it("passes a clean ad", async () => {
    const r = await runChecks(good, deps(img));
    expect(r.reject).toBe(false);
    expect(r.retry).toBe(false);
    expect(r.results.every((c) => c.ok)).toBe(true);
  });

  it("requires https links", async () => {
    const r = await runChecks({ ...good, link: "http://ok.example" }, deps(img));
    expect(r.reject).toBe(true);
    expect(r.reason).toMatch(/https/);
    expect((await runChecks({ ...good, link: "javascript:alert(1)" }, deps(img))).reject).toBe(true);
  });

  it("blocks blocklisted domains including subdomains", async () => {
    const r = await runChecks({ ...good, link: "https://www.evil.example/x" }, deps(img));
    expect(r.reject).toBe(true);
    expect(r.reason).toMatch(/blocklist/);
  });

  it("consults the drainer hook", async () => {
    const r = await runChecks({ ...good, link: "https://claim.drainer.invalid" }, deps(img));
    expect(r.reason).toMatch(/drainer/);
  });

  it("rejects sha256 mismatch against the on-chain hash", async () => {
    const r = await runChecks({ ...good, imageSha256: "00".repeat(32) }, deps(img));
    expect(r.reject).toBe(true);
    expect(r.reason).toMatch(/sha256/);
  });

  it("rejects wrong dimensions (must be w*10 x h*10)", async () => {
    const r = await runChecks({ ...good, w: 2, h: 2 }, deps(img));
    expect(r.reason).toMatch(/dimensions: expected 20x20, got 30x20/);
  });

  it("enforces the size limit", async () => {
    const r = await runChecks(good, deps(img, { maxBytes: 10 }));
    expect(r.reject).toBe(true);
  });

  it("calls the NSFW hook", async () => {
    const r = await runChecks(good, deps(img, { nsfw: { check: async () => ({ nsfw: true, score: 0.97, label: "explicit" }) } }));
    expect(r.reason).toMatch(/nsfw: flagged: explicit/);
  });

  it("treats network errors as retryable, not rejections", async () => {
    const r = await runChecks(good, deps(new Error("ECONNRESET")));
    expect(r).toMatchObject({ reject: false, retry: true });
  });

  it("refuses to fetch from non-allowlisted hosts (SSRF guard)", async () => {
    const f = new HttpImageFetcher(["arweave.net"]);
    await expect(f.fetch("http://169.254.169.254/latest/meta-data", 100)).rejects.toThrow(/not allowed/);
    await expect(f.fetch("file:///etc/passwd", 100)).rejects.toThrow(/not allowed/);
    const r = await runChecks(good, { ...deps(img), fetcher: f, resolveImageUrl: () => "http://127.0.0.1:1/x" });
    expect(r.reject).toBe(true);
  });
});
