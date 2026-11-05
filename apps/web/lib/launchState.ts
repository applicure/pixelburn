"use client";
import { useEffect, useState } from "react";
import { CLUSTER, USE_MOCK, rpcEndpoint } from "./config";

/**
 * Whether this deployment can take purchases: the program's Config account exists on chain. The site is switched to mainnet before the coin exists,
 * so it starts as "soon" and flips to "live" by itself, with no rebuild and no reload. One poller per page, and it stops once live.
 * "checking" (first load, or the RPC proxy is failing) doesn't block anything by itself: a buy against a missing Config is refused by the chain client.
 */
export type LaunchState = "checking" | "soon" | "live";

const POLL_MS = 4_000;
let state: LaunchState = USE_MOCK ? "live" : "checking";
const listeners = new Set<(s: LaunchState) => void>();
let polling = false;
const isLive = () => state === "live";

function set(next: LaunchState) {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l(next));
}

async function poll() {
  if (polling || isLive()) return;
  polling = true;
  const sdk = await import("@mpb/sdk");
  const { Connection } = await import("@solana/web3.js");
  const conn = new Connection(rpcEndpoint(), { commitment: "confirmed", disableRetryOnRateLimit: true });
  const programId = sdk.programIdForCluster(CLUSTER);
  const config = sdk.configPda(programId);
  while (!isLive()) {
    try {
      // Owner check: anyone can send lamports to the PDA, which makes an account exist without the program having initialised it.
      const info = await conn.getAccountInfo(config);
      set(info?.owner.equals(programId) ? "live" : "soon");
    } catch {
      /* keep the last known state; the next poll decides */
    }
    if (!isLive()) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  polling = false;
}

export function useLaunchState(): LaunchState {
  const [s, setS] = useState<LaunchState>(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    void poll();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
