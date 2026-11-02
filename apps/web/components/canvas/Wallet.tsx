"use client";
/**
 * Wallet layer: Solana wallet adapter with wallet-standard discovery (Phantom, Solflare,
 * Backpack and any other standard wallet register themselves), plus a demo wallet in
 * mock mode so the full purchase flow can be tried without an extension.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import type { Connection, PublicKey } from "@solana/web3.js";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { USE_MOCK, rpcEndpoint } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import type { WalletSigner } from "@/lib/chain";
import { IconClose, IconExternal, IconWallet } from "@/components/ui/icons";

const KNOWN = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/download" },
];

interface Bridge {
  address: string | null;
  label: string | null;
  signer: WalletSigner;
  connection: Connection | null;
  connecting: boolean;
  openPicker(): void;
  disconnect(): void;
}
const Ctx = createContext<Bridge | null>(null);
export const useWalletBridge = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWalletBridge outside WalletLayer");
  return v;
};

function Bridge({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [demo, setDemo] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const pending = useRef<WalletName | null>(null);

  // connect right after the user picks (adapter requires select → connect)
  useEffect(() => {
    if (pending.current && wallet.wallet?.adapter.name === pending.current && !wallet.connected && !wallet.connecting) {
      pending.current = null;
      wallet.connect().catch(() => {});
    }
  }, [wallet]);

  const value: Bridge = useMemo(() => {
    const pk: PublicKey | null = wallet.publicKey;
    return {
      address: demo ?? pk?.toBase58() ?? null,
      label: demo ? "Demo wallet" : wallet.wallet?.adapter.name ?? null,
      signer: { publicKey: pk, sendTransaction: wallet.sendTransaction },
      connection,
      connecting: wallet.connecting,
      openPicker: () => setPicker(true),
      disconnect: () => {
        setDemo(null);
        wallet.disconnect().catch(() => {});
      },
    };
  }, [wallet, connection, demo]);

  const installed = wallet.wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const choose = useCallback(
    (name: WalletName) => {
      pending.current = name;
      wallet.select(name);
      setPicker(false);
    },
    [wallet],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <WalletPicker
        open={picker}
        onClose={() => setPicker(false)}
        installed={installed.map((w) => ({ name: w.adapter.name, icon: w.adapter.icon }))}
        onChoose={(n) => choose(n as WalletName)}
        onDemo={
          USE_MOCK
            ? () => {
                const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
                setDemo("Demo" + Array.from({ length: 40 }, () => B58[Math.floor(Math.random() * 58)]).join(""));
                setPicker(false);
              }
            : undefined
        }
      />
    </Ctx.Provider>
  );
}

export function WalletLayer({ children }: { children: React.ReactNode }) {
  return (
    // same-origin proxy: no RPC URL or key ever reaches the bundle; polling confirms, so no websocket is opened
    <ConnectionProvider endpoint={rpcEndpoint()} config={{ commitment: "confirmed", disableRetryOnRateLimit: true }}>
      <WalletProvider wallets={[]} autoConnect>
        <Bridge>{children}</Bridge>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function WalletPicker({
  open,
  onClose,
  installed,
  onChoose,
  onDemo,
}: {
  open: boolean;
  onClose(): void;
  installed: { name: string; icon: string }[];
  onChoose(name: string): void;
  onDemo?: () => void;
}) {
  const reduce = useReducedMotion();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  const missing = KNOWN.filter((k) => !installed.some((i) => i.name.toLowerCase().startsWith(k.name.toLowerCase())));
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[80] grid place-items-end sm:place-items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-soot/70 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-title"
            className="relative w-full bg-kiln p-6 ring-1 ring-char sm:max-w-sm"
            initial={reduce ? { opacity: 0 } : { y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 40, opacity: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.4 }}
          >
            <div className="flex items-center justify-between">
              <h2 id="wallet-title" className="font-display text-[1.6rem] font-black [font-variation-settings:'wdth'_110]">
                Connect a wallet
              </h2>
              <button className="grid h-10 w-10 place-items-center text-ash hover:text-heat" onClick={onClose} aria-label="Close">
                <IconClose />
              </button>
            </div>
            <ul className="mt-4 grid gap-2">
              {installed.map((w, i) => (
                <li key={w.name}>
                  <button
                    ref={i === 0 ? first : undefined}
                    className="flex w-full items-center gap-3 border border-char px-4 py-3 text-left hover:border-heat"
                    onClick={() => onChoose(w.name)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.icon} alt="" width={28} height={28} />
                    <span className="flex-1 font-medium">{w.name}</span>
                    <span className="text-[0.8rem] text-cone">Detected</span>
                  </button>
                </li>
              ))}
              {missing.map((k, i) => (
                <li key={k.name}>
                  <a
                    href={k.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center gap-3 border border-char px-4 py-3 text-ash hover:border-heat hover:text-heat"
                    ref={installed.length === 0 && i === 0 && !onDemo ? (first as unknown as React.Ref<HTMLAnchorElement>) : undefined}
                  >
                    <IconWallet size={22} />
                    <span className="flex-1">Install {k.name}</span>
                    <IconExternal size={16} />
                  </a>
                </li>
              ))}
            </ul>
            {onDemo && (
              <div className="mt-5 border-t border-char pt-5">
                <button ref={installed.length === 0 ? first : undefined} className="btn-fire w-full justify-center" onClick={onDemo}>
                  Use a demo wallet
                </button>
                <p className="mt-2 text-[0.8rem] text-ash">Demo mode: nothing is signed or sent, the purchase is simulated locally.</p>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function WalletChip() {
  const w = useWalletBridge();
  if (!w.address)
    return (
      <button className="btn-line w-full justify-center" onClick={w.openPicker} disabled={w.connecting}>
        <IconWallet size={18} /> {w.connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  return (
    <div className="flex items-center justify-between gap-3 border border-char px-3 py-2.5 text-[0.9rem]">
      <span className="flex min-w-0 items-center gap-2">
        <span className="inline-block h-2 w-2 shrink-0 bg-cone" aria-hidden />
        <span className="truncate">{w.label}</span>
        <span className="num shrink-0 whitespace-nowrap text-[0.8rem] text-ash">{shortAddr(w.address)}</span>
      </span>
      <button className="shrink-0 text-[0.82rem] text-ash underline-offset-2 hover:text-heat hover:underline" onClick={w.disconnect}>
        Disconnect
      </button>
    </div>
  );
}
