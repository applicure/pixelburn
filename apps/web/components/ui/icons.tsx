/** Authored icon set: 24px grid, 1.75 stroke, square caps (blocks are square). */
import { MARK_GRID, MARK_PATH, MARK_PIXEL, WORDMARK_GRID, WORDMARK_PATH } from "@/lib/brandPaths";
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 20): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "square",
  strokeLinejoin: "miter",
  "aria-hidden": true,
});

export const IconArrow = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 12h15M13 6l6 6-6 6" /></svg>
);
export const IconClose = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconPlus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconMinus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M5 12h14" /></svg>
);
export const IconExternal = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5" /></svg>
);
export const IconUpload = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 16V4M7 9l5-5 5 5M4 15v5h16v-5" /></svg>
);
export const IconWallet = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 7h14v12H4zM4 7l11-3v3M14 12h4v3h-4z" /></svg>
);
export const IconCheck = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M5 12.5l4.5 4.5L19 7" /></svg>
);
export const IconSelect = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 4h4M12 4h0M16 4h4v4M20 12v0M20 16v4h-4M12 20h0M8 20H4v-4M4 12v0" /><path d="M9 9h6v6H9z" /></svg>
);
export const IconHand = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1.2-5.2-3L4 14a1.6 1.6 0 012.6-1.8L8 14" /></svg>
);
export const IconMap = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 4h16v16H4zM4 4l7 7M13 8h4v4h-4z" /></svg>
);
export const IconCopy = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M8 8h11v11H8zM5 15V5h10" /></svg>
);
export const IconShare = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 15V3M7 8l5-5 5 5M5 12v8h14v-8" /></svg>
);
export const IconDownload = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 3v12M7 10l5 5 5-5M5 20h14" /></svg>
);
export const IconMenu = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 8h16M4 16h16" /></svg>
);
export const IconFlame = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 21c-4 0-6.5-2.6-6.5-6.2C5.5 10 10 8.5 10 3c3.5 2 5 5 4.5 8 1-.6 1.7-1.6 2-2.8 1.3 1.6 2 3.5 2 5.6 0 4.2-2.6 7.2-6.5 7.2z" /><path d="M12 21c-1.7 0-2.8-1.1-2.8-2.7 0-2 2-2.8 2.3-5 1.6 1.2 3.3 2.8 3.3 5 0 1.6-1.1 2.7-2.8 2.7z" /></svg>
);

/** The logo: the frame P with its centre pixel, on an 11×13 grid. `unit` is CSS px per grid cell; whole numbers stay crisp. */
export function Mark({ unit = 2, className }: { unit?: number; className?: string }) {
  return (
    <svg
      width={MARK_GRID.w * unit}
      height={MARK_GRID.h * unit}
      viewBox={`0 0 ${MARK_GRID.w} ${MARK_GRID.h}`}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
    >
      <path d={MARK_PATH} fill="var(--color-flame)" fillRule="evenodd" />
      <rect x={MARK_PIXEL.x} y={MARK_PIXEL.y} width={MARK_PIXEL.w} height={MARK_PIXEL.h} fill="var(--color-heat)" />
    </svg>
  );
}

/** "PIXEL FRAME" in the logo's pixel letters, no font involved. Decorative: give the parent an accessible name. */
export function Wordmark({ unit = 1, className }: { unit?: number; className?: string }) {
  return (
    <svg
      width={WORDMARK_GRID.w * unit}
      height={WORDMARK_GRID.h * unit}
      viewBox={`0 0 ${WORDMARK_GRID.w} ${WORDMARK_GRID.h}`}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
    >
      <path d={WORDMARK_PATH} fill="var(--color-heat)" />
    </svg>
  );
}
