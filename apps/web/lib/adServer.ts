/** Server-side read of one ad for /ad/[id]. Never mock data: without an API there are no ads to show. */
import { cache } from "react";
import { API_URL, USE_MOCK } from "./config";
import type { AdShare } from "./types";

/** null = this ad does not exist (404). Throws when the API cannot answer: that is an outage, not a missing ad. */
export const getAdShareServer = cache(async (rawId: string): Promise<AdShare | null> => {
  if (USE_MOCK || !/^\d{1,10}$/.test(rawId)) return null;
  const res = await fetch(`${API_URL}/api/ads/${rawId}/share`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/ads/${rawId}/share answered ${res.status}`);
  return (await res.json()) as AdShare;
});
