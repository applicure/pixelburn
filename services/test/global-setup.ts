import postgres from "postgres";
import { createDb, runMigrations } from "../src/db/client.js";
import { testDatabaseUrl } from "./helpers.js";

/** Migrates the dedicated test database (created on demand). Requires a reachable Postgres. */
export default async function setup() {
  const url = testDatabaseUrl();
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  const admin = postgres({ host: u.hostname, port: Number(u.port || 5432), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: "postgres", max: 1, onnotice: () => {} });
  try {
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
}
