/** Renders the shareable "My ad burned X tokens" card (1200×630, OG size) to a PNG data URL. */
import { BRAND } from "@/lib/config";
import { MARK_GRID, MARK_PATH, MARK_PIXEL } from "@/lib/brandPaths";

export function renderShareCard(opts: { image: string | null; burned: string; w: number; h: number; x: number; y: number; title: string; tokenMode: boolean }) {
  return new Promise<string>((resolve) => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 630;
    const ctx = c.getContext("2d")!;
    const css = getComputedStyle(document.documentElement);
    const display = css.getPropertyValue("--font-anybody").trim() || "sans-serif";
    const sans = css.getPropertyValue("--font-schibsted").trim() || "sans-serif";
    const mono = css.getPropertyValue("--font-martian").trim() || "monospace";

    const finish = (img: HTMLImageElement | null) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 1200, 630);
      // heat floor
      const g = ctx.createRadialGradient(840, 700, 20, 840, 700, 640);
      g.addColorStop(0, "rgba(255,100,0,.65)");
      g.addColorStop(0.5, "rgba(179,32,14,.25)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1200, 630);
      // the ad, pixel-exact, scaled into a 420px box
      const box = 420;
      const k = Math.min(box / (opts.w * 10), box / (opts.h * 10));
      const iw = opts.w * 10 * k, ih = opts.h * 10 * k;
      const ix = 70 + (box - iw) / 2, iy = 105 + (box - ih) / 2;
      ctx.fillStyle = "#16110e";
      ctx.fillRect(70, 105, box, box);
      if (img) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, ix, iy, iw, ih);
      }
      ctx.strokeStyle = "#ffc23d";
      ctx.lineWidth = 3;
      ctx.strokeRect(ix - 1.5, iy - 1.5, iw + 3, ih + 3);

      ctx.fillStyle = "#9a9087";
      ctx.font = `500 26px ${sans}`;
      ctx.fillText(opts.tokenMode ? "My ad burned" : "My ad will burn about", 550, 190);
      ctx.fillStyle = "#ffc23d";
      ctx.font = `900 ${opts.burned.length > 9 ? 92 : 112}px ${display}`;
      ctx.fillText(opts.burned, 546, 300);
      ctx.fillStyle = "#fff5dc";
      ctx.font = `800 64px ${display}`;
      ctx.fillText(BRAND.ticker, 550, 375);
      ctx.fillStyle = "#9a9087";
      ctx.font = `400 22px ${mono}`;
      ctx.fillText(`${opts.w}×${opts.h} blocks at ${opts.x},${opts.y}`, 550, 440);
      ctx.fillStyle = "#fff5dc";
      ctx.font = `600 26px ${sans}`;
      ctx.fillText(opts.title.slice(0, 40), 550, 480);
      // footer
      ctx.fillStyle = "#ff6400";
      ctx.fillRect(0, 590, 1200, 40);
      // the mark needs its black ground: orange on the orange band would vanish
      ctx.fillStyle = "#000";
      ctx.fillRect(70, 590, 40, 40);
      ctx.save();
      ctx.translate(70 + (40 - MARK_GRID.w * 2) / 2, 590 + (40 - MARK_GRID.h * 2) / 2);
      ctx.scale(2, 2);
      ctx.fillStyle = "#ff6400";
      ctx.fill(new Path2D(MARK_PATH), "evenodd");
      ctx.fillStyle = "#fff5dc";
      ctx.fillRect(MARK_PIXEL.x, MARK_PIXEL.y, MARK_PIXEL.w, MARK_PIXEL.h);
      ctx.restore();
      ctx.fillStyle = "#000";
      ctx.font = `800 22px ${display}`;
      ctx.fillText(BRAND.name, 124, 618);
      ctx.font = `500 20px ${sans}`;
      const t = "A million pixels. Half of every dollar burns.";
      ctx.fillText(t, 1130 - ctx.measureText(t).width, 618);
      resolve(c.toDataURL("image/png"));
    };
    if (!opts.image) return finish(null);
    const im = new Image();
    im.onload = () => finish(im);
    im.onerror = () => finish(null);
    im.src = opts.image;
  });
}
