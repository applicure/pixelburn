"use client";
import { useState } from "react";
import { IconCheck, IconCopy } from "./icons";
import { BRAND } from "@/lib/config";

/** The token's contract address with copy and a pump.fun link. */
export function ContractAddress({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BRAND.ca);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard refused: the address stays selectable on screen
    }
  };
  return (
    <div className={`text-[0.8rem] ${className}`}>
      <div className="flex items-center justify-between gap-3 text-ash">
        <span>{BRAND.ticker} contract address</span>
        <a className="link-cobalt" href={`https://pump.fun/coin/${BRAND.ca}`} target="_blank" rel="noopener noreferrer">
          pump.fun
        </a>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${BRAND.ticker} contract address`}
        className="mt-1 flex w-full items-center justify-between gap-3 border border-char px-3 py-2 text-left text-heat hover:border-flame"
      >
        <span className="num min-w-0 break-all text-[0.72rem] leading-snug select-all">{BRAND.ca}</span>
        {copied ? <IconCheck size={16} className="shrink-0 text-cone" /> : <IconCopy size={16} className="shrink-0" />}
      </button>
    </div>
  );
}
