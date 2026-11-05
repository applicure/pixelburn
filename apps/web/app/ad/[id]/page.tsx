import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Footer } from "@/components/ui/Footer";
import { IconExternal } from "@/components/ui/icons";
import { getAdShareServer } from "@/lib/adServer";
import { API_URL, BRAND } from "@/lib/config";
import { explorerAddr, explorerTx, fmtInt, fmtSol, fmtUsd, linkHost, shortAddr } from "@/lib/format";
import { adBox, burnHeadline, cardImageUrl, exactTokens, factsFromShare } from "@/lib/share";
import type { AdShare } from "@/lib/types";

type Props = { params: Promise<{ id: string }> };

const TAGLINE = "A million pixels. Half of every dollar burns.";

function sizeText(a: AdShare) {
  return a.payMode === "auction" ? `${fmtInt(a.blockCount)} blocks` : `${a.w}×${a.h} block${a.blockCount === 1 ? "" : "s"}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const a = await getAdShareServer(id);
  if (!a) notFound();
  const where = a.payMode === "auction" ? "the final lot" : `${a.x},${a.y}`;
  // Moderation: buyer content only ever comes from a.ad, which the API leaves null until approval.
  const title = a.ad ? a.ad.title : a.status === "rejected" ? `Ad #${a.id}, not on display` : `Ad #${a.id}, in review`;
  const description = a.ad
    ? `${sizeText(a)} at ${where} on ${BRAND.name}. ${TAGLINE}`
    : `${sizeText(a)} at ${where} on ${BRAND.name}, ${a.status === "rejected" ? "not on display" : "waiting for approval"}. ${TAGLINE}`;
  const image = { url: cardImageUrl(a.id, a.cardVersion), width: 1200, height: 630, alt: `${BRAND.name} card for ad ${a.id}: ${sizeText(a)} at ${where}` };
  const canonical = `/ad/${a.id}`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: a.ad ? undefined : { index: false },
    openGraph: { type: "website", siteName: BRAND.name, url: canonical, title: `${title} · ${BRAND.name}`, description, images: [image] },
    twitter: { card: "summary_large_image", title: `${title} · ${BRAND.name}`, description, images: [image] },
  };
}

/** The whole wall with this ad's spot marked. Approved ads only, because that is all /api/canvas.png contains. */
function WallMap({ a, className = "" }: { a: AdShare; className?: string }) {
  const pct = (n: number) => `${n}%`;
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  return (
    <div className={`relative aspect-square w-full overflow-hidden bg-kiln bg-[linear-gradient(rgba(255,245,220,.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,245,220,.07)_1px,transparent_1px)] bg-[size:10%_10%] ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${API_URL}/api/canvas.png`} alt="" width={1000} height={1000} className="absolute inset-0 h-full w-full" />
      <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-flame" style={{ left: pct(cx) }} aria-hidden />
      <span className="absolute inset-x-0 h-0.5 -translate-y-1/2 bg-flame" style={{ top: pct(cy) }} aria-hidden />
      <span
        className="absolute min-h-2.5 min-w-2.5 -translate-x-1/2 -translate-y-1/2 bg-heat ring-2 ring-soot"
        style={{ left: pct(cx), top: pct(cy), width: pct(a.w), height: pct(a.h) }}
        aria-hidden
      />
    </div>
  );
}

function WhereItSits({ a, className }: { a: AdShare; className: string }) {
  return (
    <div className={`w-56 ${className}`}>
      <p className="mb-2 text-[0.8rem] text-ash">Where it sits</p>
      <WallMap a={a} className="ring-1 ring-char" />
    </div>
  );
}

export default async function AdPage({ params }: Props) {
  const { id } = await params;
  const a = await getAdShareServer(id);
  if (!a) notFound();
  const facts = factsFromShare(a);
  const head = burnHeadline(facts);
  const box = adBox(a.w, a.h);
  const canvasHref = a.payMode === "auction" ? "/canvas" : `/canvas?spot=${a.x},${a.y},${a.w},${a.h}`;
  const when = new Date(a.createdAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const stateLine = a.status === "rejected" ? "Not on display" : "In review";
  return (
    <>
      <main id="main" className="mx-auto max-w-[1240px] px-4 pb-20 pt-24 sm:px-6 lg:pt-28">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-14">
          {/* the ad, or the wall when the ad cannot be shown */}
          <div className="min-w-0">
            {a.ad ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.ad.imageUrl}
                alt={a.ad.title}
                width={box.iw}
                height={box.ih}
                className="block h-auto border-[6px] border-flame [image-rendering:pixelated]"
                // full whole-number size, narrower only for a small screen or a very tall ad; the ad's own file is often just 10 px per block
                style={{ width: `min(${box.iw + 12}px, 100%, calc(70svh * ${(box.iw / box.ih).toFixed(4)}))`, ...(box.exact ? {} : { imageRendering: "auto" }) }}
              />
            ) : (
              <div className="border-[6px] border-flame">
                <WallMap a={a} />
              </div>
            )}
            {a.ad && <WhereItSits a={a} className="mt-8 hidden lg:block" />}
          </div>

          <div className="min-w-0">
            <p className="num text-[0.78rem] text-ash">
              Ad #{a.id} · {when}
            </p>
            {a.ad ? (
              <>
                <h1 className="mt-3 break-words font-display text-[clamp(2.1rem,6vw,3.8rem)] font-black leading-[0.98] [font-variation-settings:'wdth'_105]">{a.ad.title}</h1>
                <a className="link-cobalt mt-3 inline-flex items-center gap-1.5 break-all" href={a.ad.link} target="_blank" rel="noopener noreferrer nofollow sponsored">
                  {linkHost(a.ad.link)} <IconExternal size={15} />
                </a>
              </>
            ) : (
              <>
                <h1 className="mt-3 font-display text-[clamp(2.1rem,6vw,3.8rem)] font-black leading-[0.98] [font-variation-settings:'wdth'_115]">{stateLine}</h1>
                <p className="mt-3 max-w-[52ch] text-heat/80">
                  {a.status === "rejected"
                    ? "This ad did not pass moderation, so the site does not show it. The blocks stay sold."
                    : "These blocks are sold. The ad shows here and on the wall once it is approved."}
                </p>
              </>
            )}

            <div className="mt-7 bg-flame px-5 py-5 text-soot sm:px-6">
              <p className="text-[0.95rem] font-bold">{head.label}</p>
              <p className="mt-1 break-words font-display text-[clamp(2.6rem,10vw,4.6rem)] font-black leading-none [font-variation-settings:'wdth'_125]">{head.figure}</p>
              <p className="mt-2 text-[0.92rem] font-semibold">{head.sub}</p>
            </div>

            <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-t border-char pt-5 text-[0.92rem]">
              <dt className="text-ash">Size</dt>
              <dd className="num text-[0.84rem]">{sizeText(a)}</dd>
              {a.payMode !== "auction" && (
                <>
                  <dt className="text-ash">Position</dt>
                  <dd className="num text-[0.84rem]">
                    {a.x},{a.y}
                  </dd>
                </>
              )}
              {a.usd > 0 && (
                <>
                  <dt className="text-ash">Price</dt>
                  <dd className="num text-[0.84rem]">{fmtUsd(a.usd)}</dd>
                </>
              )}
              <dt className="text-ash">Paid</dt>
              <dd className="num break-all text-[0.84rem]">{a.payMode === "token" ? `${exactTokens(a.tokensBurned)} ${BRAND.ticker}` : `${fmtSol(a.lamports, 3)} SOL`}</dd>
              <dt className="text-ash">Owner</dt>
              <dd className="num text-[0.84rem]">
                <a className="link-cobalt" href={explorerAddr(a.owner, a.cluster)} target="_blank" rel="noreferrer">
                  {shortAddr(a.owner)}
                </a>
              </dd>
              <dt className="text-ash">Transaction</dt>
              <dd className="num text-[0.84rem]">
                <a className="link-cobalt" href={explorerTx(a.signature, a.cluster)} target="_blank" rel="noreferrer">
                  {shortAddr(a.signature)}
                </a>
              </dd>
            </dl>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/canvas?select=1" className="btn-fire">
                Buy blocks
              </Link>
              <Link href={canvasHref} className="btn-line">
                See it on the wall
              </Link>
            </div>
            <p className="mt-5 text-[0.9rem] text-ash">{TAGLINE}</p>

            {a.ad && <WhereItSits a={a} className="mt-8 lg:hidden" />}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
