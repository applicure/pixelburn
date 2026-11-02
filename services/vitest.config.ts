import { randomBytes } from "node:crypto";
import { defineConfig } from "vitest/config";

// Every test run gets its OWN database (created + migrated in global-setup, dropped in teardown), so
// concurrent runs (two developers / agents, CI shards) never share state. Workers inherit this env.
// Base server/credentials: TEST_DATABASE_URL, else DATABASE_URL, else the docker-compose default.
if (!process.env.MPB_TEST_DB_ISOLATED) {
  const base = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://mpb:mpb@127.0.0.1:54329/mpb");
  base.pathname = `/mpb_test_${Date.now().toString(36)}_${process.pid}_${randomBytes(3).toString("hex")}`;
  process.env.TEST_DATABASE_URL = base.toString();
  process.env.MPB_TEST_DB_ISOLATED = "1";
}

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Files inside one run share that run's database: run them sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
