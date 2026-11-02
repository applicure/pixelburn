import { describe, expect, it } from "vitest";
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { altCandidates, LookupTableManager } from "../src/keeper/alt.js";
import { silentLogger } from "../src/lib/log.js";

const MAX = 2n ** 64n - 1n;

describe("keeper lookup table", () => {
  it("collects every non-signer account and program once, without the payer", () => {
    const payer = Keypair.generate().publicKey;
    const a = PublicKey.unique(), b = PublicKey.unique(), prog = PublicKey.unique();
    const ixs = [
      new TransactionInstruction({ programId: prog, keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: a, isSigner: false, isWritable: true }], data: Buffer.alloc(0) }),
      new TransactionInstruction({ programId: prog, keys: [{ pubkey: a, isSigner: false, isWritable: false }, { pubkey: b, isSigner: false, isWritable: false }], data: Buffer.alloc(0) }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: b, lamports: 1 }),
    ];
    const keys = altCandidates(ixs, payer).map((k) => k.toBase58()).sort();
    expect(keys).toEqual([a, b, prog, SystemProgram.programId].map((k) => k.toBase58()).sort());
  });

  it("logs a pinned table truncated (Coolify masks the full env value) and never scans", async () => {
    const payer = Keypair.generate();
    const key = new PublicKey("6rQpuXs19EpbFtPeFAG6JbwpvTQQZFYAoebSk1uEzpdf");
    const infos: string[] = [];
    let scanned = false;
    const conn = {
      getProgramAccounts: async () => ((scanned = true), []),
      getAddressLookupTable: async () => ({ value: new AddressLookupTableAccount({ key, state: { deactivationSlot: MAX, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: payer.publicKey, addresses: [PublicKey.unique()] } }) }),
    } as unknown as Connection;
    const log = { debug() {}, info: (m: string) => void infos.push(m), warn() {}, error() {} };
    const m = new LookupTableManager(conn, payer, { live: true }, log, key.toBase58(), true);
    await m.ensure([]);
    expect(infos).toContain("using pinned lookup table 6rQp…zpdf (1 addresses, no scan)");
    expect(infos.join(" ")).not.toContain(key.toBase58());
    expect(scanned).toBe(false);
  });

  it("never creates on-chain state in dry-run", async () => {
    const m = new LookupTableManager({} as Connection, Keypair.generate(), { live: false }, silentLogger);
    expect(await m.ensure([PublicKey.unique()])).toBeNull();
  });

  it("mainnet: never scans the ALT program; creates once and asks loudly to pin it", async () => {
    const payer = Keypair.generate();
    const created: string[] = [];
    const errors: string[] = [];
    let scanned = false;
    let tableKey: PublicKey | null = null;
    const conn = {
      getProgramAccounts: async () => ((scanned = true), []),
      getAddressLookupTable: async (k: PublicKey) => ({ value: new AddressLookupTableAccount({ key: k, state: { deactivationSlot: MAX, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: payer.publicKey, addresses: [] } }) }),
      getSlot: async () => 10,
      getLatestBlockhash: async () => ({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async () => "sig",
      confirmTransaction: async () => ({ value: { err: null } }),
    } as unknown as Connection;
    const log = { debug() {}, info() {}, warn() {}, error: (m: string) => void errors.push(m) };
    const m = new LookupTableManager(conn, payer, { live: true }, log, undefined, false, (a) => created.push(a));
    const t = await m.ensure([]);
    tableKey = t!.key;
    expect(scanned).toBe(false);
    expect(created).toEqual([tableKey.toBase58()]);
    expect(errors.some((e) => e.includes(`set KEEPER_LOOKUP_TABLE=${tableKey!.toBase58()}`))).toBe(true);
  });

  it("creates with a recent slot taken from SlotHashes, retrying the next one if rejected", async () => {
    const payer = Keypair.generate();
    // SlotHashes sysvar layout: u64 count, then (slot u64, hash [32]) newest first
    const slotsNewestFirst = Array.from({ length: 20 }, (_, i) => 1_000 - i);
    const data = Buffer.alloc(8 + 20 * 40);
    data.writeBigUInt64LE(20n, 0);
    slotsNewestFirst.forEach((sl, i) => data.writeBigUInt64LE(BigInt(sl), 8 + i * 40));
    const usedSlots: number[] = [];
    let sims = 0;
    const conn = {
      getAccountInfo: async () => ({ data, owner: PublicKey.default, lamports: 1, executable: false }),
      getLatestBlockhash: async () => ({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }),
      // first create is rejected like on devnet ("<slot> is not a recent slot"), the second passes
      simulateTransaction: async () => ({ value: { err: sims++ === 0 ? { InstructionError: [0, "InvalidInstructionData"] } : null, logs: [] } }),
      sendRawTransaction: async () => "sig",
      confirmTransaction: async () => ({ value: { err: null } }),
      getAddressLookupTable: async (k: PublicKey) => ({ value: new AddressLookupTableAccount({ key: k, state: { deactivationSlot: MAX, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: payer.publicKey, addresses: [] } }) }),
      getSlot: async () => 2_000,
    } as unknown as Connection;
    const created: string[] = [];
    const m = new LookupTableManager(conn, payer, { live: true }, silentLogger, undefined, false, (a) => created.push(a));
    const orig = AddressLookupTableProgram.createLookupTable;
    (AddressLookupTableProgram as any).createLookupTable = (p: { recentSlot: number }) => (usedSlots.push(Number(p.recentSlot)), orig.call(AddressLookupTableProgram, p as never));
    try {
      expect(await m.ensure([])).not.toBeNull();
    } finally {
      (AddressLookupTableProgram as any).createLookupTable = orig;
    }
    expect(usedSlots).toEqual([996, 992]); // SlotHashes entries 4 and 8 (never getSlot("finalized"))
    expect(created).toHaveLength(1);
  });

  it("rejects a table owned by another key (keeper rotated via set_keeper)", async () => {
    const payer = Keypair.generate();
    const old = Keypair.generate().publicKey;
    const tableKey = PublicKey.unique();
    const warns: string[] = [];
    const conn = {
      getAddressLookupTable: async () => ({ value: new AddressLookupTableAccount({ key: tableKey, state: { deactivationSlot: MAX, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: old, addresses: [PublicKey.unique()] } }) }),
      getSlot: async () => 10,
      getLatestBlockhash: async () => { throw new Error("must not try to use/extend the old table"); },
    } as unknown as Connection;
    const log = { debug() {}, info() {}, warn: (m: string) => void warns.push(m), error() {} };
    // configured to the old keeper's table: rejected, then a NEW table would be created (blocked here)
    const m = new LookupTableManager(conn, payer, { live: true }, log, tableKey.toBase58(), false);
    expect(await m.ensure([PublicKey.unique()])).toBeNull();
    expect(warns.some((w) => w.includes("not owned by the current keeper"))).toBe(true);
  });

  it("reuses the keeper's existing table and extends it only with missing keys", async () => {
    const payer = Keypair.generate();
    const known = PublicKey.unique(), missing = PublicKey.unique();
    const tableKey = PublicKey.unique();
    let addresses = [known];
    let extendTxs = 0;
    let slot = 100;
    const table = () => new AddressLookupTableAccount({ key: tableKey, state: { deactivationSlot: MAX, lastExtendedSlot: 100, lastExtendedSlotStartIndex: 0, authority: payer.publicKey, addresses } });
    const conn = {
      getProgramAccounts: async () => [{ pubkey: tableKey }],
      getAddressLookupTable: async () => ({ value: table() }),
      getSlot: async () => ++slot,
      getLatestBlockhash: async () => ({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async () => {
        extendTxs++;
        addresses = [known, missing];
        return "sig";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as unknown as Connection;
    const m = new LookupTableManager(conn, payer, { live: true }, silentLogger, undefined, true); // devnet: scan allowed
    expect((await m.ensure([known]))!.key.equals(tableKey)).toBe(true);
    expect(extendTxs).toBe(0); // nothing missing: no tx
    const t = await m.ensure([known, missing]);
    expect(extendTxs).toBe(1);
    expect(t!.state.addresses.map((x) => x.toBase58())).toContain(missing.toBase58());
  });
});
