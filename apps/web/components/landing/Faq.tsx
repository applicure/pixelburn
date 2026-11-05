"use client";
import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BRAND } from "@/lib/config";
import { useBuybacksLive } from "@/lib/usePhase";
import { IconPlus } from "@/components/ui/icons";

const qa = (live: boolean): { q: string; a: string }[] => [
  {
    q: "What do I actually get?",
    a: "A rectangle of whole 10×10 blocks on the billboard, showing your image and linking where you choose. The record is on Solana under your wallet, and you can update the image and link or transfer the ad later.",
  },
  {
    q: "How much does it cost?",
    a: !live ? `$1 per pixel, so $100 per block, paid in SOL at the live SOL/USD oracle price. Paying with ${BRAND.ticker} is coming soon.` : `$1 per pixel, so $100 per block. Paying in SOL uses the live SOL/USD oracle price. Paying in ${BRAND.ticker} takes 10% off and converts at the lowest of the pool price and two on-chain averages, so a pump never makes your ad cheaper. ${BRAND.ticker} payments pause briefly after a sharp price spike and are capped at 1,000 blocks an hour; SOL always works.`,
  },
  {
    q: "Where does the money go?",
    a: !live ? `SOL payments split in the purchase transaction: 50% to the treasury, 50% to the buyback vault, where it builds up for now. You can follow the balance on the buyback page. Buybacks are coming soon.` : `SOL payments split in the purchase transaction: 50% to the treasury, 50% to a buyback vault that the program spends only on buying ${BRAND.ticker} and burning it. ${BRAND.ticker} payments are burned in full, in the same transaction.`,
  },
  ...(live
    ? []
    : [
        {
          q: "What is coming soon?",
          a: `Buyback-and-burn and paying with ${BRAND.ticker}. They come together with a later program upgrade, which will be announced as a new feature. ${BRAND.ticker} itself is launching on pump.fun.`,
        },
      ]),
  {
    q: "Can the team change the program?",
    a: "Yes. The program is upgradeable, and one team-held key controls upgrades and settings. There is no multisig or timelock, so those rules hold unless that key changes them. Every upgrade is public on-chain.",
  },
  {
    q: "Where is my image stored?",
    a: "On Arweave, which is paid once and stored permanently. The ad record on-chain keeps the image URI and its SHA-256 hash, so anyone can check the picture hasn't been swapped.",
  },
  {
    q: "Can any image go up?",
    a: "The purchase is permanent on-chain, but this site only displays ads that pass moderation. Illegal or abusive images are not shown here, and the blocks stay yours.",
  },
  {
    q: "What happens at 99%?",
    a: "Fixed-price sales stop and every remaining free block becomes a single lot in a 72-hour SOL auction. Outbid bidders are refunded automatically. The winning bid goes 100% to " + (live ? "buyback and burn." : "the buyback vault."),
  },
  {
    q: `Is ${BRAND.ticker} an investment?`,
    a: (live ? "No. It is the token this billboard burns." : "No. It is the token launching on pump.fun for this billboard's coming buybacks.") + " Nothing here is financial advice, prices can go to zero, and you should only spend what you are happy to spend on an ad.",
  },
];

function Item({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <div className="border-b border-char">
      <h3>
        <button
          className="group flex w-full items-center justify-between gap-6 py-6 text-left"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <span className="font-display text-[clamp(1.25rem,2.4vw,1.75rem)] font-bold leading-tight transition-[font-variation-settings] duration-500 [font-variation-settings:'wdth'_100] group-hover:[font-variation-settings:'wdth'_120]">
            {q}
          </span>
          <motion.span animate={{ rotate: open ? 45 : 0 }} transition={{ type: "spring", bounce: 0, duration: 0.35 }} className={open ? "text-flame" : "text-ash"}>
            <IconPlus size={26} />
          </motion.span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            role="region"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.45 }}
            className="overflow-hidden"
          >
            <p className="max-w-[62ch] pb-7 text-heat/80">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  const QA = qa(useBuybacksLive());
  return (
    <section className="py-24 sm:py-32" aria-labelledby="faq-title">
      <div className="mx-auto grid max-w-[1400px] gap-10 px-4 sm:px-6 lg:grid-cols-12">
        <h2 id="faq-title" className="font-black text-[clamp(2.4rem,6vw,5rem)] [font-variation-settings:'wdth'_96] lg:col-span-4">
          Questions
        </h2>
        <div className="border-t border-char lg:col-span-8">
          {QA.map((x, i) => (
            <Item key={x.q} {...x} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
          ))}
        </div>
      </div>
    </section>
  );
}
