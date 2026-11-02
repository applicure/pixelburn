import { PublicKey } from "@solana/web3.js";
import {
  AD_AUCTION_SEED,
  AD_SEED,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AUCTION_SEED,
  BUYBACK_VAULT_SEED,
  CANVAS_SEED,
  CONFIG_SEED,
  PROGRAM_ID,
  PYTH_PUSH_ORACLE_PROGRAM_ID,
  SOL_USD_FEED_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { hexToBytes } from "./util.js";

const enc = new TextEncoder();

export function configPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(CONFIG_SEED)], programId)[0];
}
export function canvasPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(CANVAS_SEED)], programId)[0];
}
export function buybackVaultPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(BUYBACK_VAULT_SEED)], programId)[0];
}
export function auctionPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(AUCTION_SEED)], programId)[0];
}
/** Rect ad: ["ad", top-left block index (y*100+x) u16 LE]. Unique per ad because blocks are exclusive. */
export function adPdaForBlock(blockIndex: number, programId: PublicKey = PROGRAM_ID): PublicKey {
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= 10_000) throw new RangeError(`bad block index ${blockIndex}`);
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, blockIndex, true);
  return PublicKey.findProgramAddressSync([enc.encode(AD_SEED), b], programId)[0];
}

/** Rect ad whose top-left block is (x, y). */
export function adPda(x: number, y: number, programId: PublicKey = PROGRAM_ID): PublicKey {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 99 || y > 99) throw new RangeError(`bad block (${x},${y})`);
  return adPdaForBlock(y * 100 + x, programId);
}

/** The single final-auction ad: ["ad_auction"]. */
export function auctionAdPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode(AD_AUCTION_SEED)], programId)[0];
}

/** Associated token account (works for SPL Token and Token-2022). */
export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Pyth sponsored price-feed account (push oracle, continuously updated, Full verification).
 * PDA of the push-oracle program with seeds [shard_id u16 LE, feed_id].
 */
export function pythPriceFeedAccount(
  feedIdHex: string = SOL_USD_FEED_ID,
  shardId = 0,
  pushOracleProgramId: PublicKey = PYTH_PUSH_ORACLE_PROGRAM_ID,
): PublicKey {
  const shard = new Uint8Array(2);
  new DataView(shard.buffer).setUint16(0, shardId, true);
  return PublicKey.findProgramAddressSync([shard, hexToBytes(feedIdHex)], pushOracleProgramId)[0];
}
