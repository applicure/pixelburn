// Secret redaction for everything we log (and error details we return).
// Secrets are registered by loadConfig(); patterns catch keys we never saw (e.g. inside
// URLs built by libraries).

const secrets = new Set<string>();

const MIN_SECRET_LEN = 6; // shorter values would mangle unrelated text (e.g. a dev password "mpb")
const add = (v: string | undefined) => {
  if (v && v.length >= MIN_SECRET_LEN) secrets.add(v);
};

export function registerSecret(s: string | undefined | null) {
  if (!s) return;
  add(s);
  // Also the encoded form and, for URLs, the parts that carry keys (QuickNode keys live in the path).
  add(encodeURIComponent(s));
  try {
    const u = new URL(s);
    if (u.pathname.length > 8) add(u.pathname.replace(/\/$/, ""));
    for (const [, v] of u.searchParams) add(v);
    if (u.password) add(decodeURIComponent(u.password));
  } catch {
    /* not a URL */
  }
}

/** Test helper. */
export function clearSecrets() {
  secrets.clear();
}

const PATTERNS: [RegExp, string][] = [
  [/([?&](?:api[-_]?key|apikey|token|key|secret)=)[^&\s"']+/gi, "$1***"],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1***@"], // user:password@host
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/g, "$1***"],
];

export function redact(text: string): string {
  let out = text;
  // Longest first so a full URL is replaced before its parts.
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (out.includes(s)) out = out.split(s).join("***");
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (v instanceof Error) {
    const e = new Error(redact(v.message));
    e.name = v.name;
    e.stack = v.stack ? redact(v.stack) : undefined;
    return e;
  }
  if (v && typeof v === "object") {
    try {
      return JSON.parse(redact(JSON.stringify(v)));
    } catch {
      return "[unserializable]";
    }
  }
  return v;
}

let installed = false;
/** Route console.* through redaction (covers library logging, e.g. web3.js / websockets). */
export function installConsoleRedaction() {
  if (installed) return;
  installed = true;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => orig(...args.map(redactValue));
  }
}
