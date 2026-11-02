/** A lazily loaded chunk 404'd: the site was redeployed while this tab was open (version skew). */
export function isChunkLoadError(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  const text = `${err?.name ?? ""} ${err?.message ?? ""}`;
  return /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(text);
}

export const SKEW_MESSAGE = "The site was updated while this tab was open. Reload the page and try again; nothing was charged.";
