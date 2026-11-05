/**
 * Validates a mint from chain before anything depends on it. Config.token_mint can never be changed after initialize, so a wrong mint here
 * means a new program deployment.
 *
 * What pump.fun's launch options do to the things we rely on (docs + @pump-fun/pump-sdk 4.3.1, checked 2026-11-05):
 *   - create_v2 (what the site uses today): Token-2022, metadata in the mint's own extensions, 6 decimals. Legacy `create`: SPL Token + Metaplex. Both work.
 *   - mayhem mode: a separate agent trades the coin and the mint's supply can differ, so supply-based maths break. Refused.
 *   - cashback: deprecated, no new coins. Refused if ever seen (the creator fee goes to traders).
 *   - holder rewards / tokenized agent: fees go elsewhere, but layout, supply and price reads are unchanged. Allowed, reported.
 *   - custom quote (USDC or a pump coin instead of SOL): the program and SDK parser refuse a curve not quoted in SOL. Refused.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, parseBondingCurve, spotPriceQ } from "@mpb/sdk";
import { COIN, TOKEN_INITIAL_SUPPLY, firstAnswer } from "./mainnet-lib.ts";

export interface MintCheck {
  ok: boolean; errors: string[]; notes: string[];
  tokenProgram?: PublicKey; curve: PublicKey; pool: PublicKey; complete: boolean; spot: bigint | null;
  name?: string; symbol?: string; creator?: string; supply?: bigint;
}

const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
/** Mint-extension types pump's create_v2 uses. Anything else (transfer fee, hook, permanent delegate, ...) would change what a burn or a payment means. */
const ALLOWED_EXTENSIONS = new Set([18, 19]); // MetadataPointer, TokenMetadata

export function parseMint(data: Uint8Array) {
  const mintAuth = u64(data, 0) !== 0n ? new DataView(data.buffer, data.byteOffset).getUint32(0, true) : 0;
  const freezeOpt = new DataView(data.buffer, data.byteOffset).getUint32(46, true);
  const out = { supply: u64(data, 36), decimals: data[44]!, hasMintAuthority: mintAuth === 1, hasFreezeAuthority: freezeOpt === 1, extensions: [] as number[], name: undefined as string | undefined, symbol: undefined as string | undefined };
  if (data.length > 166) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let o = 166; // after the 165-byte base layout + account-type byte
    while (o + 4 <= data.length) {
      const type = dv.getUint16(o, true), len = dv.getUint16(o + 2, true);
      if (type === 0) break;
      out.extensions.push(type);
      if (type === 19) {
        // TokenMetadata: update_authority 32, mint 32, then borsh strings name, symbol, uri
        let p = o + 4 + 64;
        const str = () => { const n = dv.getUint32(p, true); const s = new TextDecoder().decode(data.subarray(p + 4, p + 4 + n)); p += 4 + n; return s; };
        out.name = str(); out.symbol = str();
      }
      o += 4 + len;
    }
  }
  return out;
}

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export async function validateMint(conns: Connection[], mint: PublicKey, o: { expectName?: string; expectSymbol?: string; expectCreator?: string } = {}): Promise<MintCheck> {
  const errors: string[] = [], notes: string[] = [];
  const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
  const pool = canonicalPumpPoolPda(mint);
  const r: MintCheck = { ok: false, errors, notes, curve, pool, complete: false, spot: null };
  const [mintAcc, curveAcc] = await firstAnswer(conns, (c) => c.getMultipleAccountsInfo([mint, curve]));
  if (!mintAcc) { errors.push(`mint ${mint.toBase58()} doesn't exist on this cluster`); return r; }
  if (!mintAcc.owner.equals(TOKEN_PROGRAM_ID) && !mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID)) { errors.push(`${mint.toBase58()} isn't a token mint (owner ${mintAcc.owner.toBase58()})`); return r; }
  r.tokenProgram = mintAcc.owner;
  const m = parseMint(mintAcc.data);
  r.supply = m.supply;
  if (m.decimals !== 6) errors.push(`decimals are ${m.decimals}, expected 6`);
  if (m.hasFreezeAuthority) errors.push("the mint has a freeze authority: not a plain pump.fun coin");
  if (m.hasMintAuthority) errors.push("the mint still has a mint authority: supply could grow");
  const foreign = m.extensions.filter((e) => !ALLOWED_EXTENSIONS.has(e));
  if (foreign.length) errors.push(`Token-2022 extensions other than metadata: ${foreign.join(", ")}`);
  if (!curveAcc) { errors.push(`no pump.fun bonding curve at the canonical address ${curve.toBase58()}: this isn't a pump.fun coin`); return r; }
  if (!curveAcc.owner.equals(PUMP_PROGRAM_ID)) { errors.push(`curve account is owned by ${curveAcc.owner.toBase58()}`); return r; }
  let parsed;
  try { parsed = parseBondingCurve(curveAcc.data); } catch (e) { errors.push(`${(e as Error).message} (custom-quote coins can't be used)`); return r; }
  const d = curveAcc.data;
  r.complete = parsed.complete;
  if (!r.complete) r.spot = spotPriceQ(parsed.quoteLamports, parsed.baseUnits);
  const total = u64(d, 40);
  if (total.toString() !== TOKEN_INITIAL_SUPPLY) errors.push(`curve's token_total_supply is ${total}, expected ${TOKEN_INITIAL_SUPPLY}: TOKEN_INITIAL_SUPPLY and burnedPct assume it`);
  if (d.length >= 81) r.creator = new PublicKey(d.subarray(49, 81)).toBase58();
  // Name and symbol can be copied by anyone; the creator on the curve can't. Config.token_mint has no setter, so this is the check that counts.
  if (o.expectCreator && r.creator !== o.expectCreator) errors.push(`curve creator is ${r.creator ?? "absent"}, expected ${o.expectCreator}: not the owner's coin`);
  if (d.length > 81 && d[81] === 1) errors.push("this is a mayhem-mode coin: refused, its supply and fee flow differ");
  if (d.length > 82 && d[82] === 1) errors.push("this is a cashback coin: refused");
  if (d.length >= 115 && d.subarray(83, 115).some((b) => b !== 0) && !new PublicKey(d.subarray(83, 115)).equals(WSOL_MINT)) errors.push("curve isn't quoted in SOL");
  if (d.length > 124 && d[124] === 1) notes.push("holder-rewards coin: creator fees go to holders. Pricing and burns are unaffected.");
  if (m.supply.toString() !== TOKEN_INITIAL_SUPPLY) {
    // pump's post-migration boost burns supply, so a graduated coin may legitimately be below.
    if (r.complete && m.supply < BigInt(TOKEN_INITIAL_SUPPLY)) notes.push(`supply is ${m.supply}, below ${TOKEN_INITIAL_SUPPLY}: pump's post-graduation burn. TOKEN_INITIAL_SUPPLY still holds.`);
    else errors.push(`mint supply is ${m.supply}, expected ${TOKEN_INITIAL_SUPPLY}: TOKEN_INITIAL_SUPPLY and burnedPct assume it`);
  }
  // Name and symbol, so a mistyped or copycat mint can't be locked into Config for good.
  r.name = m.name; r.symbol = m.symbol;
  if (r.name === undefined && mintAcc.owner.equals(TOKEN_PROGRAM_ID)) {
    const pda = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];
    const md = await firstAnswer(conns, (c) => c.getAccountInfo(pda));
    if (md) {
      const dv = new DataView(md.data.buffer, md.data.byteOffset, md.data.byteLength);
      let p = 65;
      const str = () => { const n = dv.getUint32(p, true); const s = new TextDecoder().decode(md.data.subarray(p + 4, p + 4 + n)).replace(/\0+$/, ""); p += 4 + n; return s; };
      r.name = str(); r.symbol = str();
    }
  }
  const wantName = o.expectName ?? COIN.name, wantSymbol = o.expectSymbol ?? COIN.symbol;
  if (r.name !== wantName || r.symbol !== wantSymbol) errors.push(`on-chain name/symbol "${r.name}" / "${r.symbol}", expected "${wantName}" / "${wantSymbol}"`);
  r.ok = errors.length === 0;
  return r;
}
