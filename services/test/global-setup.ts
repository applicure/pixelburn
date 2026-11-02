import postgres from "postgres";
import { createDb, runMigrations } from "../src/db/client.js";
import { testDatabaseUrl } from "./helpers.js";

/**
 * Creates and migrates this run's private test database (name chosen in vitest.config.ts) and drops
 * it again in teardown. Stale per-run databases older than a day are swept too. Needs Postgres.
 */
export default async function setup() {
  const url = testDatabaseUrl();
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  const adminConn = () => postgres({ host: u.hostname, port: Number(u.port || 5432), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: "postgres", max: 1, onnotice: () => {} });
  const admin = adminConn();
  try {
    // Sweep leftovers from crashed runs (names encode the start time in base36).
    const stale = await admin<{ datname: string }[]>`select datname from pg_database where datname like 'mpb_test\_%'`;
    for (const { datname } of stale) {
      const ts = parseInt(datname.split("_")[2] ?? "", 36);
      if (datname !== dbName && Number.isFinite(ts) && Date.now() - ts > 86_400_000) {
        await admin.unsafe(`drop database if exists "${datname.replace(/"/g, "")}" with (force)`).catch(() => {});
      }
    }
    const exists = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (!exists.length) await admin.unsafe(`create database "${dbName.replace(/"/g, "")}"`);
  } catch (e) {
    throw new Error(`Postgres not reachable at ${u.host} (start it with: docker compose up -d postgres): ${(e as Error).message}`);
  } finally {
    await admin.end();
  }
  const h = createDb(url, { max: 1 });
  await h.sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await runMigrations(h);
  await h.close();

  return async function teardown() {
    const a = adminConn();
    try {
      await a.unsafe(`drop database if exists "${dbName.replace(/"/g, "")}" with (force)`);
    } finally {
      await a.end();
    }
  };
}
