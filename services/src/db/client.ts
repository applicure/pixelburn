import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;
export interface DbHandle {
  url: string;
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { url, db, sql, close: () => sql.end({ timeout: 5 }) };
}

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Advisory lock keys (arbitrary, fixed). */
export const LOCK_MIGRATIONS = 7_204_771_001;
export const LOCK_INDEXER = 7_204_771_002;

/**
 * Migrations under a session advisory lock so api + indexer starting together don't race.
 * Uses its own 2-connection pool (one holds the lock, one runs drizzle's migration tx),
 * so it works whatever the caller's pool size is.
 */
export async function runMigrations(handle: DbHandle): Promise<void> {
  const tmp = createDb(handle.url, { max: 2 });
  const conn = await tmp.sql.reserve();
  try {
    await conn`select pg_advisory_lock(${LOCK_MIGRATIONS})`;
    await migrate(tmp.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await conn`select pg_advisory_unlock(${LOCK_MIGRATIONS})`.catch(() => {});
    conn.release();
    await tmp.close();
  }
}

/**
 * Holds a session-level advisory lock on a dedicated single-connection client (single
 * active indexer). `acquire` polls pg_try_advisory_lock until free (a rolling deploy's new
 * container waits here). Loss detection: the client's `onclose`, plus a 10s check that this
 * backend still holds the lock (a silent reconnect would get a new backend without it).
 */
export class AdvisoryLease {
  private client: postgres.Sql | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private held = false;
  private onLost: (() => void) | null = null;
  constructor(
    private readonly handle: DbHandle,
    private readonly key: number,
  ) {}

  private makeClient() {
    return postgres(this.handle.url, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: null, // never recycle the connection: that would drop the lock
      onnotice: () => {},
      onclose: () => {
        if (this.held) this.lost();
      },
    });
  }

  async acquire(opts: { pollMs?: number; onWait?: () => void; onLost: () => void }): Promise<boolean> {
    const pollMs = opts.pollMs ?? 5_000;
    this.onLost = opts.onLost;
    while (!this.stopped) {
      try {
        this.client ??= this.makeClient();
        const [row] = await this.client<{ ok: boolean }[]>`select pg_try_advisory_lock(${this.key}) as ok`;
        if (row?.ok) {
          this.held = true;
          this.timer = setInterval(() => void this.verify(), 10_000);
          return true;
        }
      } catch {
        await this.closeClient();
      }
      opts.onWait?.();
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  private async verify() {
    if (!this.held || !this.client) return;
    try {
      const [row] = await this.client<{ n: number }[]>`
        select count(*)::int as n from pg_locks
         where locktype = 'advisory' and pid = pg_backend_pid() and granted
           and ((classid::bigint << 32) | objid::bigint) = ${this.key}`;
      if (!row || row.n === 0) this.lost();
    } catch {
      this.lost();
    }
  }

  private lost() {
    if (!this.held) return;
    this.held = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.closeClient();
    this.onLost?.();
  }

  private async closeClient() {
    const c = this.client;
    this.client = null;
    await c?.end({ timeout: 1 }).catch(() => {});
  }

  async release() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.held && this.client) await this.client`select pg_advisory_unlock(${this.key})`.catch(() => {});
    this.held = false;
    await this.closeClient();
  }
}

/** Postgres NOTIFY channel used to fan out feed/stats events across processes. */
export const NOTIFY_CHANNEL = "mpb_events";
