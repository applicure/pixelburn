import { describe, expect, it } from "vitest";
import { fetchHermesSolUsd } from "../src/pyth.js";
import { SOL_USD_FEED_ID } from "../src/constants.js";

describe("hermes REST parsing (mocked fetch)", () => {
  it("extracts update data and parsed price", async () => {
    const body = {
      binary: { encoding: "base64", data: ["UE5BVQ=="] },
      parsed: [{ id: SOL_USD_FEED_ID, price: { price: "15000000000", conf: "1000000", expo: -8, publish_time: 1_800_000_000 } }],
    };
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      expect(url).toContain(`ids[]=${SOL_USD_FEED_ID}`);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    const r = await fetchHermesSolUsd("https://hermes.example/", fakeFetch, "k");
    expect(r.updateData).toEqual(["UE5BVQ=="]);
    expect(r.price.price).toBe(15_000_000_000n);
    expect(r.price.expo).toBe(-8);
  });
});
