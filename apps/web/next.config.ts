import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== "production";

/** Origins the page actually talks to; everything else is blocked by CSP. */
const apiOrigin = (() => {
  try {
    return process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : "";
  } catch {
    return "";
  }
})();
// ad images: services' resolved URLs (API origin) or Arweave/Irys gateways
const imageHosts = ["https://arweave.net", "https://*.arweave.net", "https://gateway.irys.xyz", "https://*.irys.xyz"];

const csp = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts on static pages (no nonce without going dynamic); dev needs eval for HMR
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  // motion and the canvas UI set inline styles
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${apiOrigin} ${imageHosts.join(" ")}`.trim(),
  "font-src 'self'",
  // same-origin covers /api/rpc; the API origin covers REST + SSE
  `connect-src 'self' ${apiOrigin}${isDev ? " ws: http://localhost:*" : ""}`.trim(),
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

/**
 * Former hosts redirect here once the domain moves (build args, docs/domain-cutover.md). Temporary so it can be undone.
 * /api/rpc and /_next stay served so tabs opened before the move keep working until their next navigation.
 */
const legacyHosts = (process.env.LEGACY_SITE_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://pixelframe.tech";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // Version-skew protection: a tab opened before a deploy hard-reloads on its next navigation instead of
  // asking the new server for chunks that no longer exist. Set from the git SHA at build time (Dockerfile).
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || undefined,
  // trace from the monorepo root so the standalone bundle includes the @mpb/sdk workspace package
  outputFileTracingRoot: path.join(here, "../.."),
  experimental: {
    optimizePackageImports: ["motion"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    return legacyHosts.map((host) => ({
      source: "/:path((?!api/|_next/|healthz).*)",
      has: [{ type: "host" as const, value: host.replace(/\./g, "\\.") }],
      destination: `${siteUrl}/:path`,
      permanent: false,
    }));
  },
};

export default nextConfig;
