import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../lib/log.js";

export interface StoredFile {
  /** Value to put on-chain as image_uri (≤ 200 chars). */
  uri: string;
  /** Browser-fetchable URL. */
  url: string;
}

export interface Storage {
  readonly kind: "local" | "irys";
  put(bytes: Buffer, contentType: string, sha256Hex: string): Promise<StoredFile>;
}

const extFor = (ct: string) => (ct === "image/webp" ? "webp" : ct === "image/jpeg" ? "jpg" : "png");

/** Dev fallback: files on disk, served by the API at /files/<name>. */
export class LocalStorage implements Storage {
  readonly kind = "local" as const;
  constructor(
    readonly dir: string,
    readonly publicBaseUrl: string,
  ) {}
  async put(bytes: Buffer, contentType: string, sha: string): Promise<StoredFile> {
    await mkdir(this.dir, { recursive: true });
    const name = `${sha}.${extFor(contentType)}`;
    await writeFile(path.join(this.dir, name), bytes);
    const url = `${this.publicBaseUrl}/files/${name}`;
    return { uri: url, url };
  }
  async read(name: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{64}\.(png|webp|jpg)$/.test(name)) return null;
    return readFile(path.join(this.dir, name)).catch(() => null);
  }
}

/** Arweave via Irys. Uses the Solana token; IRYS_KEY is a base58 secret key. */
export class IrysStorage implements Storage {
  readonly kind = "irys" as const;
  private uploader: any;
  constructor(
    private readonly key: string,
    private readonly network: "devnet" | "mainnet",
    private readonly rpcUrl: string,
    private readonly log: Logger,
  ) {}
  private async client() {
    if (this.uploader) return this.uploader;
    const { Uploader } = await import("@irys/upload");
    const { Solana } = await import("@irys/upload-solana");
    let b = (Uploader as any)(Solana).withWallet(this.key).withRpc(this.rpcUrl);
    if (this.network === "devnet") b = b.devnet();
    this.uploader = await b;
    return this.uploader;
  }
  async put(bytes: Buffer, contentType: string, sha: string): Promise<StoredFile> {
    const irys = await this.client();
    const price = await irys.getPrice(bytes.length);
    const balance = await irys.getBalance();
    if (balance.lt(price)) {
      this.log.info(`irys: funding ${price.toString()} atomic units`);
      await irys.fund(price.multipliedBy(1.2).integerValue());
    }
    const receipt = await irys.upload(bytes, {
      tags: [
        { name: "Content-Type", value: contentType },
        { name: "App-Name", value: "pixel-frame" },
        { name: "Sha256", value: sha },
      ],
    });
    const host = this.network === "devnet" ? "https://devnet.irys.xyz" : "https://gateway.irys.xyz";
    const url = `${host}/${receipt.id}`;
    // ar://<id> is gateway-neutral; resolveImageUrl maps it back to a URL.
    return { uri: this.network === "devnet" ? url : `ar://${receipt.id}`, url };
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/**
 * If `uri` points at a dev-storage file (`/files/<sha256>.<ext>`) on this API (PUBLIC_API_URL), on a former
 * origin of this API (PUBLIC_API_URL_ALIASES: the URI is immutable on-chain, the domain isn't) or on a
 * localhost URL (e.g. data seeded before PUBLIC_API_URL was set), return the file name.
 */
export function localFileName(uri: string, publicBaseUrl: string, aliases: readonly string[] = []): string | null {
  try {
    const u = new URL(uri);
    const m = /^\/files\/([a-f0-9]{64}\.(?:png|webp|jpg))$/.exec(u.pathname);
    if (!m) return null;
    if (u.origin === new URL(publicBaseUrl).origin || aliases.includes(u.origin) || LOCAL_HOSTS.has(u.hostname)) return m[1]!;
  } catch {
    /* not a URL */
  }
  return null;
}

/** Map an on-chain image_uri to a URL a browser (or the composer) can fetch. */
export function makeImageUrlResolver(arweaveGateway: string, publicBaseUrl: string, aliases: readonly string[] = []) {
  return (uri: string): string => {
    if (uri.startsWith("ar://")) return `${arweaveGateway.replace(/\/$/, "")}/${uri.slice(5)}`;
    // Dev-storage files are always served from PUBLIC_API_URL, never a stale localhost or former origin.
    const local = localFileName(uri, publicBaseUrl, aliases);
    if (local) return `${publicBaseUrl}/files/${local}`;
    return uri;
  };
}
