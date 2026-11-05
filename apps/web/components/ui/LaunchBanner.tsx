"use client";
import { BRAND, CLUSTER } from "@/lib/config";
import { useLaunchState } from "@/lib/launchState";

/** Shown only on mainnet before the program is initialised. It disappears by itself the moment buying opens. */
export function LaunchBanner() {
  const s = useLaunchState();
  if (CLUSTER !== "mainnet-beta" || s !== "soon") return null;
  return (
    <p role="status" className="pointer-events-none fixed bottom-3 left-1/2 z-40 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 border border-flame/40 bg-soot/90 px-3 py-1.5 text-center text-[0.8rem] text-heat">
      {BRAND.name} is launching soon. Buying opens here the moment it&apos;s live, no need to reload.
    </p>
  );
}
