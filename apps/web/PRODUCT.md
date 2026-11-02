# Product

<!-- impeccable:product-schema 1 -->

> Inferred from the team lead's brief and /SPEC.md (no interactive answer mechanism was available to the web agent). Every fact below is sourced from those two documents.

## Platform

web

## Stack

Pinned by the brief: Next.js App Router, React 19, TypeScript, Tailwind v4, motion, GSAP + ScrollTrigger, Lenis, three / @react-three/fiber, Solana wallet adapter. pnpm workspace package `@mpb/web`.

## Users

- Crypto-native buyers on Solana who want a permanent, public spot on a famous billboard and like that their purchase burns $PIXEL.
- $PIXEL holders checking burn progress, treasury transparency and auction state.
- People who remember (or have heard of) the 2005 Million Dollar Homepage and arrive via nostalgia/press.

## Product Purpose

A 1000×1000 px billboard (100×100 blocks of 10×10 px), sold at $1/pixel. Pay in SOL (50% treasury / 50% buyback-and-burn of $PIXEL) or pay in $PIXEL at a 10% discount, 100% burned. The final 1% is sold in a 72h SOL auction whose winning bid goes 100% to buyback. Images are stored on Arweave permanently. Success = pixels sold, tokens burned, the canvas filling up.

## Positioning

Every purchase is literally a burn. The page is the billboard itself: what you see is the live, on-chain canvas, not an illustration.

## Operating Context

Visitors arrive from X/Telegram on phones (375–430px) as often as desktop. Buying happens on /canvas with a browser wallet (Phantom, Solflare, Backpack).

## Capabilities and Constraints

- Services API and SDK are built in parallel; web must run against a deterministic mock when `NEXT_PUBLIC_API_URL` is unset.
- Ticker `$PIXEL` and name are placeholders; keep in one constant.
- Only approved ads render; occupancy includes pending.

## Evidence on Hand

Historical facts (2005): Alex Tew, 1,000,000 pixels at $1 in 10×10 blocks, sold out 11 Jan 2006, $1,037,100 raised, last 1,000 pixels auctioned on eBay for $38,100. No real 2026 sales, partners, testimonials or press exist; all live numbers in dev are mock and must be labeled as such.

## Product Principles

1. The canvas is the hero, everywhere.
2. Every number is live and verifiable on-chain; never decorative.
3. Fire is the consequence of buying; show money moving, not slogans.
4. Respect the 2005 original: it is the origin story, not a joke.

## Accessibility & Inclusion

WCAG AA contrast, full keyboard path through canvas selection and purchase, `prefers-reduced-motion` gets a calm but complete version.
