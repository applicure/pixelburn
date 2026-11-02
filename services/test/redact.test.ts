import { afterEach, describe, expect, it } from "vitest";
import { clearSecrets, redact, redactValue } from "../src/lib/redact.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/lib/log.js";
import { makeImageUrlResolver } from "../src/uploads/storage.js";
import { vi } from "vitest";

afterEach(() => clearSecrets());

describe("secret redaction + infra env", () => {
  it("redacts the RPC URL, Helius key, DB password and tokens; leaves normal text alone", () => {
    const cfg = loadConfig({
      SOLANA_RPC: "https://black-quiet-sea.solana-devnet.quiknode.pro/0123456789abcdef0123/",
      SOLANA_RPC_HELIUS_KEY: "1111aaaa-2222-bbbb-3333-cccc4444dddd",
      DATABASE_URL: "postgres://app:sup3r-s3cret@db:5432/mpb",
      ADMIN_TOKEN: "admin-token-123456",
    });
    const line = `rpc ${cfg.rpcUrl} ws ${cfg.wsUrl} db ${cfg.DATABASE_URL} auth Bearer ${cfg.ADMIN_TOKEN} @mpb/sdk`;
    const out = redact(line);
    for (const s of ["0123456789abcdef0123", "1111aaaa-2222", "sup3r-s3cret", "admin-token-123456"]) expect(out).not.toContain(s);
    expect(out).toContain("@mpb/sdk");
    expect(redact("GET https://x.io/?api-key=unregistered123&a=1")).toBe("GET https://x.io/?api-key=***&a=1");
    const e = redactValue(new Error(`connect failed ${cfg.rpcUrl}`)) as Error;
    expect(e.message).not.toContain("0123456789abcdef0123");
  });

  it("builds Helius websocket URLs from the cluster and key; SOLANA_RPC wins for HTTP", () => {
    const dev = loadConfig({ SOLANA_RPC: "https://qn.example/k123456/", SOLANA_RPC_HELIUS_KEY: "hkey-123456" });
    expect(dev.rpcUrl).toBe("https://qn.example/k123456/");
    expect(dev.wsUrl).toBe("wss://devnet.helius-rpc.com/?api-key=hkey-123456");
    const main = loadConfig({ SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_HELIUS_KEY: "hkey-123456" });
    expect(main.rpcUrl).toBe("https://mainnet.helius-rpc.com/?api-key=hkey-123456");
    const ovr = loadConfig({ SOLANA_RPC: "https://qn.example/k/", RPC_URL: "http://127.0.0.1:8899", WS_URL: "ws://127.0.0.1:8900" });
    expect([ovr.rpcUrl, ovr.wsUrl]).toEqual(["http://127.0.0.1:8899", "ws://127.0.0.1:8900"]);
    expect(loadConfig({ CORS_ORIGINS: "https://pixelburn.applicure.io/, http://localhost:3000" }).corsOrigins).toEqual([
      "https://pixelburn.applicure.io",
      "http://localhost:3000",
    ]);
    expect(loadConfig({ PUBLIC_API_URL: "https://api.pixelburn.applicure.io/" }).publicBaseUrl).toBe("https://api.pixelburn.applicure.io");
  });
});

describe("log output", () => {
  it("never contains the RPC URL or keys, even via raw console calls and Error objects", () => {
    const cfg = loadConfig({
      SOLANA_RPC: "https://x.quiknode.pro/QNKEY-0123456789abcdef/",
      SOLANA_RPC_HELIUS_KEY: "helius-key-0123456789",
      LOG_LEVEL: "debug",
    });
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(" "))),
    );
    const log = createLogger("t", "debug"); // installs the console redaction wrapper
    log.info(`connecting ${cfg.rpcUrl} / ${cfg.wsUrl}`);
    log.error("failed", new Error(`fetch failed for ${cfg.rpcUrl}`));
    console.warn(`library says: ws ${cfg.wsUrl} closed`); // raw library-style logging
    spies.forEach((s) => s.mockRestore());
    const all = lines.join("\n");
    expect(lines.length).toBe(3);
    expect(all).not.toContain("QNKEY-0123456789abcdef");
    expect(all).not.toContain("helius-key-0123456789");
    expect(all).not.toContain("quiknode.pro/QNKEY");
  });
});

describe("PUBLIC_API_URL image URLs", () => {
  it("serves dev-storage files from PUBLIC_API_URL, never a stale localhost origin", () => {
    const sha = "a".repeat(64);
    const r = makeImageUrlResolver("https://arweave.net", "https://api.pixelburn.applicure.io");
    expect(r(`http://localhost:8788/files/${sha}.png`)).toBe(`https://api.pixelburn.applicure.io/files/${sha}.png`);
    expect(r("ar://abc")).toBe("https://arweave.net/abc");
    expect(r(`https://evil.example/files/${sha}.png`)).toBe(`https://evil.example/files/${sha}.png`); // foreign hosts untouched
  });
});
