"use client";
import { isChunkLoadError } from "@/lib/skew";

/** Last-resort boundary (replaces the root layout), so it brings its own minimal styling. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const skew = isChunkLoadError(error);
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#000", color: "#fff5dc", fontFamily: "system-ui, sans-serif", padding: 16 }}>
        <div style={{ maxWidth: 520 }}>
          <h1 style={{ fontSize: 40, lineHeight: 1, margin: 0, fontWeight: 900 }}>{skew ? "A new version just went live." : "The page couldn't load."}</h1>
          <p style={{ color: "rgba(255,245,220,.8)", lineHeight: 1.6 }}>
            {skew ? "The site was updated while this tab was open. Reload to get the latest version." : "Something went wrong. Reload to try again."} Nothing was bought or charged.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ background: "#ff6400", color: "#000", border: 0, padding: "12px 20px", fontWeight: 800, fontSize: 16, cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
