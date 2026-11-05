// Rehearsal only: a JSON-RPC proxy that silently swallows sendTransaction, as a congested leader would. It answers with the real signature and forwards nothing.
//   UPSTREAM=<rpc> PORT=8901 DROP_SENDS=8 [DROP_FOR_MS=0] node rehearse-drop-proxy.mjs
// Everything else is forwarded. It prints only counts, never the upstream.
import { createServer } from "node:http";
import { createRequire } from "node:module";
const bs58 = createRequire(import.meta.url)("bs58").default;
const { UPSTREAM, PORT = "8901", DROP_SENDS = "0", DROP_FOR_MS = "0" } = process.env;
if (/mainnet|quiknode|quicknode/.test(UPSTREAM)) { console.error("REFUSING: this looks like a mainnet endpoint"); process.exit(1); }
const started = Date.now();
let dropped = 0, passed = 0;
createServer((req, res) => {
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString();
    const j = JSON.parse(body || "{}");
    if (j.method === "sendTransaction" && (dropped < Number(DROP_SENDS) || Date.now() - started < Number(DROP_FOR_MS))) {
      dropped++;
      const raw = Buffer.from(j.params[0], j.params[1]?.encoding === "base64" ? "base64" : "base64");
      console.log(`dropped send #${dropped}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: bs58.encode(raw.subarray(1, 65)) }));
      return;
    }
    if (j.method === "sendTransaction") console.log(`forwarded send #${++passed}`);
    const r = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => null);
    res.setHeader("content-type", "application/json");
    res.statusCode = r ? r.status : 502;
    res.end(r ? await r.text() : "{}");
  });
}).listen(Number(PORT), "127.0.0.1", () => console.log(`proxy on ${PORT}`));
