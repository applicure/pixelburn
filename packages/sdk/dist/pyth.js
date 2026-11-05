import "./chunk-EMP2Q7F4.js";
import {
  DEFAULT_HERMES_URL,
  SOL_USD_FEED_ID
} from "./chunk-GMGWLDHJ.js";

// src/pyth.ts
async function fetchHermesSolUsd(hermesUrl = DEFAULT_HERMES_URL, fetchImpl = fetch, apiKey) {
  const url = `${hermesUrl.replace(/\/$/, "")}/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&encoding=base64&parsed=true`;
  const res = await fetchImpl(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : void 0);
  if (!res.ok) throw new Error(`Hermes ${res.status}`);
  const body = await res.json();
  const p = body.parsed?.find((x) => x.id.replace(/^0x/, "") === SOL_USD_FEED_ID);
  if (!p) throw new Error("Hermes response missing SOL/USD");
  return {
    updateData: body.binary.data,
    price: {
      price: BigInt(p.price.price),
      conf: BigInt(p.price.conf),
      expo: p.price.expo,
      publishTime: p.price.publish_time,
      feedId: SOL_USD_FEED_ID,
      verified: false
      // off-chain value; only the posted account is verified
    }
  };
}
async function loadReceiver() {
  try {
    return await import("@pythnetwork/pyth-solana-receiver");
  } catch (e) {
    const isNode = typeof process !== "undefined" && !!process.versions?.node;
    if (!isNode) throw e;
    const nodeModule = "node:module";
    const { createRequire } = await import(
      /* webpackIgnore: true */
      /* @vite-ignore */
      nodeModule
    );
    return createRequire(import.meta.url)("@pythnetwork/pyth-solana-receiver");
  }
}
async function receiverFor(connection, wallet) {
  const mod = await loadReceiver();
  return new mod.PythSolanaReceiver({ connection, wallet });
}
async function buildPostPriceUpdateIxs(p) {
  const receiver = await receiverFor(p.connection, p.wallet);
  const { updateData } = await fetchHermesSolUsd(p.hermesUrl, fetch, p.hermesApiKey);
  const r = await receiver.buildPostPriceUpdateInstructions(updateData);
  const acct = r.priceFeedIdToPriceUpdateAccount["0x" + SOL_USD_FEED_ID] ?? r.priceFeedIdToPriceUpdateAccount[SOL_USD_FEED_ID];
  if (!acct) throw new Error("Hermes update did not include SOL/USD");
  return { postInstructions: r.postInstructions, priceUpdateAccount: acct, closeInstructions: r.closeInstructions };
}
async function buildTransactionsWithFreshPrice(p) {
  const receiver = await receiverFor(p.connection, p.wallet);
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: p.closeUpdateAccounts ?? true });
  await builder.addPostPriceUpdates((await fetchHermesSolUsd(p.hermesUrl, fetch, p.hermesApiKey)).updateData);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const ixs = await p.makeIxs(getPriceUpdateAccount("0x" + SOL_USD_FEED_ID));
    return ixs.map((instruction) => ({ instruction, signers: [] }));
  });
  return builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: p.computeUnitPriceMicroLamports ?? 5e4 });
}
export {
  buildPostPriceUpdateIxs,
  buildTransactionsWithFreshPrice,
  fetchHermesSolUsd
};
//# sourceMappingURL=pyth.js.map