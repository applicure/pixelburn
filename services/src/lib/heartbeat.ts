import { writeFileSync } from "node:fs";

/** Touch a heartbeat file; the Docker HEALTHCHECK (src/healthcheck.ts) checks its age. */
export function heartbeat(file: string | undefined) {
  if (!file) return;
  try {
    writeFileSync(file, String(Date.now()));
  } catch {
    /* best effort */
  }
}
