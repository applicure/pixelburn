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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // trace from the monorepo root so the standalone bundle includes the @mpb/sdk workspace package
  outputFileTracingRoot: path.join(here, "../.."),
  experimental: {
    optimizePackageImports: ["motion"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
