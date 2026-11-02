"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Lenis smooth scroll. Off on /canvas (it owns its own gestures) and for reduced motion. */
export function SmoothScroll() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname.startsWith("/canvas")) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let destroyed = false;
    let destroy = () => {};
    import("lenis").then(({ default: Lenis }) => {
      if (destroyed) return;
      const lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 0.95, autoRaf: true, anchors: true });
      destroy = () => lenis.destroy();
    });
    return () => {
      destroyed = true;
      destroy();
    };
  }, [pathname]);
  return null;
}
