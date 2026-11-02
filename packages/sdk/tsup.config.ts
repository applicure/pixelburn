import { cpSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", pyth: "src/pyth.ts", quote: "src/quote-entry.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  // keep heavy deps external; consumers resolve them
  external: ["@solana/web3.js", "@anchor-lang/core", "bn.js", "@pythnetwork/pyth-solana-receiver"],
  async onSuccess() {
    mkdirSync("dist/idl", { recursive: true });
    cpSync("src/idl/pixel.json", "dist/idl/pixel.json");
  },
});
