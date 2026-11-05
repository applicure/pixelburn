import { ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { indexerCursor } from "../db/schema.js";

/**
 * A database belongs to one deployment. The indexer's cursor row is keyed by program id, so any row for another program means
 * this database holds another deployment's ads (devnet rows on mainnet, say). Refuse to start rather than serve them mixed:
 * the fix is a fresh DATABASE_URL (docs/mainnet-cutover.md), never deleting rows from here.
 */
export async function assertDatabaseIsForProgram(db: Db, programId: string): Promise<void> {
  const foreign = await db.select({ id: indexerCursor.id }).from(indexerCursor).where(ne(indexerCursor.id, programId)).limit(1);
  if (foreign.length) throw new Error(`this database holds data of another program (${foreign[0]!.id}), not ${programId}: use a fresh DATABASE_URL`);
}
