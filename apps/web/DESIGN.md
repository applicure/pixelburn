# DESIGN — The Million Pixel Burn (web)

Seed key `384a3862` (impeccable concept seed, mode: persuade, assigned index 4).

## How the direction was chosen

The category rut: a crypto launch page on near-black with a purple/green gradient,
glass cards and a "hero + 3 feature cards" grid. Its predictable opposite: a cream
editorial broadsheet. Both were ruled out. The literal reading of the name (a
billboard on fire) was allowed one slot only.

Grounded candidates, ordered by resonance with the audience (Solana buyers,
$PIXEL holders, people who remember the 2005 page):

1. The 2005 Million Dollar Homepage itself, Y2K web chrome as the system
2. Times Square LED tower / exchange ticker board
3. A billboard on fire (literal reading)
4. **A kiln and its glaze test-tile board** ← assigned by the roll
5. A perforated sheet of postage stamps with cancellation marks
6. Fireworks shell label art
7. Foundry ingot ledger

Challengers dealt by the roll (fused and weighed on audience identification and
product clarity): torn flyer wall (strong layering metaphor, but paper is
ephemeral and contradicts "on Arweave forever"); depot destination blind (its
stepped-snap motion is adopted for the odometers, the world itself fuses poorly
with a canvas of ads); film cutting bench, memory quilt, mesophotic dive and
orienteering map fuse poorly because none of them carries "payment = burn".
The kiln wins product clarity outright: firing is the one process where heat is
what makes a surface permanent, which is exactly the product (every purchase
burns, every ad is forever).

## Thesis

The billboard is a glaze test board inside a kiln. Every ad is a fired tile;
every purchase raises the heat. The site reads like a firing: cold 2005 web at
the top, heat rising as you scroll, white-hot burn ledger, then the final firing
(the auction). The canvas is always the hero.

## Palette (tokens in `app/globals.css`)

Colour strategy: **committed**, the heat ramp owns whole regions; it is a data
scale (temperature = how much has burned), never a decorative gradient.

| Token | Hex | Role |
|---|---|---|
| `soot` | `#000000` | cold kiln interior, canvas surround, default ground |
| `cherry` | `#B3200E` | 800 °C, deep heat, pressed/active states |
| `flame` | `#FF5B14` | 1000 °C, drenched "firing" sections, primary action |
| `cone` | `#FFC23D` | 1200 °C, live data highlights, focus ring |
| `white-heat` | `#FFF6E8` | 1300 °C, primary text on soot |
| `cobalt` | `#2B47E8` | cobalt glaze: what is *kept* (treasury, SOL) and links, a nod to 2005 blue links |
| `ash` | `#9A9087` | secondary text on soot (6.4:1) |

Rule: burn (fire, tokens destroyed) is always the heat ramp; kept value
(treasury) is always cobalt. Money-flow, charts and legends never swap them.

## Type

- **Anybody** (variable, `wdth` 50–150, `wght` 100–900): display. Width is the
  kinetic axis; letters *expand as they heat* (wide = hot, condensed = cold).
- **Schibsted Grotesk**: running text and UI. Body 17/28, measure ≤ 68ch.
- **Martian Mono**: only for measurements (prices, counters, addresses, block
  coordinates) — pyrometer readouts, never as a "tech" costume.
- 2005 section quotes Times New Roman / Verdana / Tahoma on purpose; that is
  historical citation, not the site's voice.

Scale (major third, rem): 0.8 / 1 / 1.25 / 1.563 / 1.953 / 2.441 / 3.815 / 5.96.
Display tracking −0.035em, body 0, small data +0.02em.

## Layout

- Landing is one long firing schedule: hero (canvas on the kiln shelf) → 2005
  (cold web, burns away under scroll) → the split (money flow) → pay in $PIXEL →
  the controller (odometers + firing log) → final firing (auction) → questions →
  footer. Dense passages alternate with a single quiet full-bleed moment.
- Left-aligned text, asymmetric 12-col grid; the canvas breaks the grid.
- Mobile-first: at 375px the canvas leads at full width; the headline sits under
  it at the same weight, not a shrunk desktop.
- Corners: tiles are square (0 radius) because blocks are square; only the
  purchase sheet (a physical drawer) has a 20px top radius.

## Motion language

- **Heat rises**: embers drift upward; things that heat widen (font `wdth`);
  cooling settles with a critically damped spring.
- **Mechanical counters**: odometer drums snap one digit pitch with a single
  overshoot (borrowed from the destination-blind challenger).
- **Signature moment**: on load 10,000 embers rise from the bottom of the hero
  and settle into the 100×100 block grid, then the ads "fire" into colour.
- UI springs: damping 1.0 response ~0.35s by default; the purchase sheet uses
  damping 0.8 (it is thrown and caught); drag pans use momentum projection
  (d = 0.998) and rubber-banding at the canvas edge.
- `prefers-reduced-motion`: no particles, no scroll scrub, no parallax; the
  burn story becomes stepped cross-fades, counters update without rolling, the
  hero shows the finished canvas with a slow single glow fade-in.
