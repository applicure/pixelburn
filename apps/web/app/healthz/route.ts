export const dynamic = "force-dynamic";

/** Liveness for Docker/Coolify. Cheap on purpose: no upstream calls. */
export function GET() {
  return Response.json({ ok: true, service: "web", ts: Date.now() }, { headers: { "cache-control": "no-store" } });
}
