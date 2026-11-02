import { afterAll, describe, expect, it } from "vitest";
import { AdvisoryLease, createDb, LOCK_INDEXER } from "../src/db/client.js";
import { testDatabaseUrl } from "./helpers.js";

const a = createDb(testDatabaseUrl(), { max: 2 });
const b = createDb(testDatabaseUrl(), { max: 2 });
afterAll(async () => {
  await a.close();
  await b.close();
});

describe("single-indexer advisory lease", () => {
  it("second instance waits until the first releases", async () => {
    const key = LOCK_INDEXER + 1000; // don't collide with a dev indexer
    const first = new AdvisoryLease(a, key);
    expect(await first.acquire({ onLost: () => {} })).toBe(true);

    const second = new AdvisoryLease(b, key);
    let waits = 0;
    let acquired = false;
    const p = second.acquire({ pollMs: 50, onWait: () => waits++, onLost: () => {} }).then((ok) => (acquired = ok));
    await new Promise((r) => setTimeout(r, 300));
    expect(acquired).toBe(false);
    expect(waits).toBeGreaterThan(1);

    await first.release();
    await p;
    expect(acquired).toBe(true);
    await second.release();
  });

  it("detects losing the lock when its backend is terminated", async () => {
    const key = LOCK_INDEXER + 2000;
    const lease = new AdvisoryLease(a, key);
    let lost = false;
    expect(await lease.acquire({ onLost: () => (lost = true) })).toBe(true);
    await a.sql`select pg_terminate_backend(pid) from pg_locks
                 where locktype = 'advisory' and ((classid::bigint << 32) | objid::bigint) = ${key}`;
    for (let i = 0; i < 50 && !lost; i++) await new Promise((r) => setTimeout(r, 100));
    expect(lost).toBe(true);
    await lease.release();
  });
});
