import type { Metadata, Viewport } from "next";
import { Anybody, Martian_Mono, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";
import { SiteNav } from "@/components/ui/SiteNav";
import { SmoothScroll } from "@/components/ui/SmoothScroll";
import { SkewGuard } from "@/components/ui/SkewGuard";
import { BRAND } from "@/lib/config";

const anybody = Anybody({ subsets: ["latin"], axes: ["wdth"], variable: "--font-anybody", display: "swap" });
// body face: "optional" so a slow first load keeps the metric-matched fallback instead of reflowing the hero (CLS)
const schibsted = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted", display: "optional" });
const martian = Martian_Mono({ subsets: ["latin"], variable: "--font-martian", display: "swap", preload: false });

export const metadata: Metadata = {
  title: { default: `${BRAND.name}: a million pixels, half of every dollar burns`, template: `%s · ${BRAND.shortName}` },
  description:
    "The 2005 Million Dollar Homepage, rebuilt on Solana. $1 per pixel. Pay in SOL and half buys back and burns " +
    `${BRAND.ticker}; pay in ${BRAND.ticker} at 10% off and every token you pay burns. Images live on Arweave forever.`,
  metadataBase: new URL("https://pixelburn.example"),
  openGraph: { title: BRAND.name, description: "A million pixels. Half of every dollar burns.", type: "website" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

const CONTRACT = `
THESIS: The billboard is a glaze test board inside a kiln; every purchase raises the heat. Refuses the crypto default of purple gradients, glass cards and hero-plus-three-features.
OWN-WORLD: soot #000 ground; heat ramp cherry #B3200E, flame #FF5B14, cone #FFC23D, white-heat #FFF6E8 as a data scale for burn; cobalt glaze #2B47E8 for what is kept (treasury, links). Square tiles, no rounded cards. Anybody (width axis = temperature), Schibsted Grotesk text, Martian Mono only for measurements.
STORY: Visitor sees the live billboard, understands 2005 to 2026, sees money split into treasury and fire, buys blocks on /canvas.
FIRST VIEWPORT: The live 1000x1000 canvas assembling from 10,000 rising embers fills the right/top; headline left/below; Buy pixels button in nav and under the headline.
FORM: candidate 4 of 7 (kiln and test-tile board); seed 384a3862.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anybody.variable} ${schibsted.variable} ${martian.variable}`}>
      <body>
        <div hidden dangerouslySetInnerHTML={{ __html: `<!--${CONTRACT}-->` }} />
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:bg-cone focus:px-4 focus:py-2 focus:text-soot">
          Skip to content
        </a>
        <SmoothScroll />
        <SkewGuard />
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
