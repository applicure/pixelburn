// Keeper-owned Address Lookup Table. The atomic buyback (release -> PumpSwap buy -> record with the
// price-source accounts) touches ~30 accounts, which exceeds the 1232-byte tx limit without an ALT
// (seen on devnet: 1263 raw bytes). Static accounts go into one ALT owned by the keeper; it is found
// again after restarts (KEEPER_LOOKUP_TABLE, else an on-chain search by authority) and extended when
// a tx needs keys it doesn't have yet (e.g. a rotated PumpSwap fee recipient).
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Logger } from "../lib/log.js";
import { sendIxsResult, type SendOptions } from "./actions.js";

const MAX_U64 = 18446744073709551615n;
const EXTEND_BATCH = 25;

/** Every account key a set of instructions references (programs included), minus the signer/payer. */
export function altCandidates(ixs: TransactionInstruction[], payer: PublicKey): PublicKey[] {
  const seen = new Map<string, PublicKey>();
  for (const ix of ixs) {
    seen.set(ix.programId.toBase58(), ix.programId);
    for (const k of ix.keys) if (!k.isSigner) seen.set(k.pubkey.toBase58(), k.pubkey);
  }
  seen.delete(payer.toBase58());
  return [...seen.values()];
}

export class LookupTableManager {
  private table: AddressLookupTableAccount | null = null;
  constructor(
    private readonly conn: Connection,
    private readonly payer: Keypair,
    private readonly opts: SendOptions,
    private readonly log: Logger,
    private readonly configured?: string,
    /**
     * Allow discovering the keeper's ALT by scanning the ALT program (getProgramAccounts). Devnet only:
     * on mainnet there are millions of ALTs, so the scan is slow or rejected. There KEEPER_LOOKUP_TABLE
     * is required, and an unset value creates one table and asks (loudly) for it to be pinned.
     */
    private readonly allowScan = false,
    /** Called with the address of a newly created table (status file / heartbeat note). */
    private readonly onCreated?: (address: string) => void,
  ) {}

  /**
   * An ALT is only used if it is active AND its authority is the CURRENT keeper key. After set_keeper
   * rotates the keeper, a table owned by the old key is rejected here (and a new one is created), so a
   * table the new key can't extend is never relied on.
   */
  private async load(addr: PublicKey) {
    const t = (await this.conn.getAddressLookupTable(addr, { commitment: "confirmed" })).value;
    if (!t) return null;
    if (t.state.deactivationSlot !== MAX_U64) {
      this.log.warn(`lookup table ${addr.toBase58()} is deactivated — not using it`);
      return null;
    }
    if (!t.state.authority?.equals(this.payer.publicKey)) {
      this.log.warn(`lookup table ${addr.toBase58()} is not owned by the current keeper (rotated key?) — not using it`);
      return null;
    }
    return t;
  }

  /** Configured ALT, else an existing active ALT with the keeper as authority, else null. */
  private async find(): Promise<AddressLookupTableAccount | null> {
    if (this.configured) return this.load(new PublicKey(this.configured));
    if (!this.allowScan) return null; // mainnet: never scan the ALT program
    try {
      const found = await this.conn.getProgramAccounts(AddressLookupTableProgram.programId, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 22, bytes: this.payer.publicKey.toBase58() } }],
      });
      for (const f of found) {
        const t = await this.load(f.pubkey);
        if (t) return t;
      }
    } catch (e) {
      this.log.warn(`lookup table search failed (${(e as Error).message}); set KEEPER_LOOKUP_TABLE to reuse one`);
    }
    return null;
  }

  /** The table in use (for status reporting), if any. */
  get address(): string | null {
    return this.table?.key.toBase58() ?? null;
  }

  /** Returns an ALT containing every key in `keys` (creating/extending it), or null in dry-run / on failure. */
  async ensure(keys: PublicKey[]): Promise<AddressLookupTableAccount | null> {
    if (!this.opts.live) return null; // never create on-chain state in dry-run
    this.table ??= await this.find();
    if (this.table && !this.configured && !this.allowScan) {
      // created earlier in this process on mainnet but not pinned yet: keep nagging every run
      this.log.error(`ACTION REQUIRED: set KEEPER_LOOKUP_TABLE=${this.table.key.toBase58()}`);
    }
    if (!this.table) {
      // create_lookup_table derives the address from a `recent_slot` that MUST be in the SlotHashes
      // sysvar. getSlot("finalized") can return a slot the simulating node doesn't list (skipped slot /
      // load-balanced RPC): "<slot> is not a recent slot". Take real entries from SlotHashes, a few back
      // for margin, and try the next one if the first is rejected.
      let created: { addr: PublicKey; sig: string } | null = null;
      for (const recentSlot of await this.recentSlots()) {
        const [ix, addr] = AddressLookupTableProgram.createLookupTable({ authority: this.payer.publicKey, payer: this.payer.publicKey, recentSlot });
        const r = await sendIxsResult(this.conn, this.payer, [ix], this.opts, this.log, "alt-create");
        if (r.sig) {
          created = { addr, sig: r.sig };
          break;
        }
        this.log.warn(`lookup table create with recent slot ${recentSlot} failed: ${(r.error ?? "").slice(0, 200)}`);
      }
      if (!created) {
        this.log.error("lookup table create failed for every recent slot tried");
        return null;
      }
      const { addr } = created;
      const r = { sig: created.sig };
      const pin = `set KEEPER_LOOKUP_TABLE=${addr.toBase58()}`;
      if (this.allowScan) this.log.info(`created keeper lookup table ${addr.toBase58()} (${r.sig}); ${pin} to pin it`);
      else this.log.error(`ACTION REQUIRED: created keeper lookup table ${addr.toBase58()} (${r.sig}). ${pin} — otherwise the next restart creates another one (no ALT scan on mainnet)`);
      this.onCreated?.(addr.toBase58());
      this.table = await this.waitFor(addr, 0);
      if (!this.table) return null;
    }
    const have = new Set(this.table.state.addresses.map((a) => a.toBase58()));
    const missing = keys.filter((k) => !have.has(k.toBase58()));
    if (missing.length === 0) return this.table;
    for (let i = 0; i < missing.length; i += EXTEND_BATCH) {
      const batch = missing.slice(i, i + EXTEND_BATCH);
      const ix = AddressLookupTableProgram.extendLookupTable({
        lookupTable: this.table.key, authority: this.payer.publicKey, payer: this.payer.publicKey, addresses: batch,
      });
      const r = await sendIxsResult(this.conn, this.payer, [ix], this.opts, this.log, "alt-extend");
      if (!r.sig) {
        this.log.error(`lookup table extend failed: ${r.error}`);
        return null;
      }
    }
    // New entries are only usable from the slot after the extension.
    this.table = await this.waitFor(this.table.key, have.size + missing.length);
    if (this.table) this.log.info(`lookup table ${this.table.key.toBase58()} now has ${this.table.state.addresses.length} addresses`);
    return this.table;
  }

  /** A few real, recent slots from the SlotHashes sysvar (newest first, skipping the very newest). */
  private async recentSlots(): Promise<number[]> {
    let info: { data: Buffer } | null = null;
    try {
      info = await this.conn.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed");
    } catch {
      info = null;
    }
    if (!info) return [await this.conn.getSlot("finalized")]; // fallback; may be rejected, logged by caller
    const d = info.data;
    const n = Number(d.readBigUInt64LE(0));
    const slots: number[] = [];
    for (let i = 0; i < Math.min(n, 40); i++) slots.push(Number(d.readBigUInt64LE(8 + i * 40)));
    return [slots[4], slots[8], slots[16]].filter((x): x is number => x !== undefined);
  }

  private async waitFor(addr: PublicKey, minAddresses: number): Promise<AddressLookupTableAccount | null> {
    for (let i = 0; i < 30; i++) {
      const t = await this.load(addr).catch(() => null);
      if (t && t.state.addresses.length >= minAddresses) {
        const slot = await this.conn.getSlot("confirmed");
        if (minAddresses === 0 || slot > t.state.lastExtendedSlot) return t;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    this.log.error(`lookup table ${addr.toBase58()} not ready in time`);
    return null;
  }
}
