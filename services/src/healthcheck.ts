// Docker HEALTHCHECK helper (node:24-slim has no curl/wget).
//   node dist/healthcheck.js http /readyz            -> GET http://127.0.0.1:$PORT/readyz must be 2xx
//   node dist/healthcheck.js heartbeat <file> <secs> -> file mtime/content must be newer than <secs>
import { readFileSync } from "node:fs";

const [mode, arg, maxAge] = process.argv.slice(2);
const fail = (why: string) => {
  console.error(`unhealthy: ${why}`);
  process.exit(1);
};

if (mode === "http") {
  const port = process.env.PORT ?? "8080";
  fetch(`http://127.0.0.1:${port}${arg ?? "/readyz"}`, { signal: AbortSignal.timeout(4_000) })
    .then((r) => (r.ok ? process.exit(0) : fail(`HTTP ${r.status}`)))
    .catch((e: Error) => fail(e.message));
} else if (mode === "heartbeat") {
  try {
    const ts = Number(readFileSync(arg!, "utf8"));
    const age = (Date.now() - ts) / 1000;
    if (!(age <= Number(maxAge ?? 180))) fail(`heartbeat ${age.toFixed(0)}s old`);
    process.exit(0);
  } catch (e) {
    fail((e as Error).message);
  }
} else fail(`unknown mode ${mode}`);
