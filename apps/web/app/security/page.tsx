import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "@/components/ui/Footer";
import { BRAND, SECURITY_CONTACT } from "@/lib/config";

export const metadata: Metadata = {
  title: "Security",
  description: `How to report a security issue in ${BRAND.name}: the contact address and what is in scope.`,
};

const IN_SCOPE = [
  "The on-chain program (`pixel`) and its buyback vault. Addresses are on the burns page.",
  "This website and its same-origin RPC proxy.",
  "The API, indexer and buyback keeper behind this site.",
];

const OUT_OF_SCOPE = [
  "Wallets, RPC providers, Pyth, pump.fun, PumpSwap and other third parties: report those to their teams.",
  "Ads that break the rules. Those are a moderation matter, not a vulnerability, unless the image or link attacks visitors.",
  "Denial of service, spam and social engineering.",
];

function Code({ text }: { text: string }) {
  // lists above are plain strings; `backticks` mark identifiers
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") ? <code key={i} className="num text-[0.9em]">{part.slice(1, -1)}</code> : part,
      )}
    </>
  );
}

export default function Page() {
  return (
    <>
      <main id="main" className="mx-auto max-w-[68ch] px-4 pb-24 pt-32 sm:px-6">
        <h1 className="font-black text-[clamp(2.6rem,9vw,5rem)] leading-none [font-variation-settings:'wdth'_120]">Security</h1>
        <p className="mt-6 text-heat/80">
          Found a way to take funds, bypass a payment or burn, or harm people using this site? Tell us before you tell anyone else.
        </p>

        <h2 className="mt-14 text-[1.5rem] font-bold">How to report</h2>
        <p className="mt-3 text-heat/80">
          Email{" "}
          <a className="link-cobalt" href={`mailto:${SECURITY_CONTACT}`}>
            {SECURITY_CONTACT}
          </a>{" "}
          with what you found, how to reproduce it and what it could do. A transaction signature or a short script helps most.
          English or German is fine.
        </p>
        <p className="mt-3 text-heat/80">
          Please test on devnet where you can, don&apos;t touch funds or data that aren&apos;t yours, and give us a reasonable chance
          to fix the issue before you publish it.
        </p>

        <h2 className="mt-14 text-[1.5rem] font-bold">In scope</h2>
        <ul className="mt-3 grid list-disc gap-2 pl-5 text-heat/80">
          {IN_SCOPE.map((t) => (
            <li key={t}><Code text={t} /></li>
          ))}
        </ul>

        <h2 className="mt-14 text-[1.5rem] font-bold">Out of scope</h2>
        <ul className="mt-3 grid list-disc gap-2 pl-5 text-heat/80">
          {OUT_OF_SCOPE.map((t) => (
            <li key={t}><Code text={t} /></li>
          ))}
        </ul>

        <p className="mt-14 text-[0.9rem] text-ash">
          See the <Link className="link-cobalt" href="/burns">burns page</Link> for the program, vault, treasury and mint addresses.
        </p>
      </main>
      <Footer />
    </>
  );
}
