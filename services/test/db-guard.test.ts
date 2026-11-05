import { afterAll, describe, expect, it } from "vitest";
import { indexerCursor } from "../src/db/schema.js";
import { assertDatabaseIsForProgram } from "../src/indexer/guard.js";
import { makeTestContext, truncateAll } from "./helpers.js";

describe("database belongs to one deployment", () => {
  const made = makeTestContext();
  afterAll(async () => { await (await made).ctx.handle.close(); });

  it("passes on an empty database and on the program's own cursor; refuses another program's cursor", async () => {
    const { ctx } = await made;
    await truncateAll(ctx);
    await expect(assertDatabaseIsForProgram(ctx.db, "MineMineMine")).resolves.toBeUndefined();
    await ctx.db.insert(indexerCursor).values({ id: "MineMineMine", updatedAt: new Date() });
    await expect(assertDatabaseIsForProgram(ctx.db, "MineMineMine")).resolves.toBeUndefined();
    await ctx.db.insert(indexerCursor).values({ id: "SomeOtherProgram", updatedAt: new Date() });
    await expect(assertDatabaseIsForProgram(ctx.db, "MineMineMine")).rejects.toThrow(/another program/);
  });
});
