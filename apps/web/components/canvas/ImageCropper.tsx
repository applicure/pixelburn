"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconUpload } from "@/components/ui/icons";

/**
 * Pick an image and frame it at the exact ad size (w*10 × h*10 px).
 * Drag (or arrow keys) to reposition, slider to zoom. Emits a PNG at native size.
 */
export function ImageCropper({ w, h, onChange }: { w: number; h: number; onChange(blob: Blob | null, dataUrl: string | null): void }) {
  const W = w * 10, H = h * 10;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [name, setName] = useState("");
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 }); // -1..1 of the overflow
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const out = useRef<HTMLCanvasElement>(null);
  const big = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // display box: fit W×H inside 100% × 220px
  const maxW = typeof window !== "undefined" && window.innerWidth < 480 ? 200 : 300, maxH = 200;
  const k = Math.min(maxW / W, maxH / H);
  const dw = Math.max(24, Math.round(W * k)), dh = Math.max(24, Math.round(H * k));

  const load = (file: File) => {
    setErr(null);
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) return setErr("Use a PNG, JPG, GIF or WebP image.");
    if (file.size > 5 * 1024 * 1024) return setErr("That file is over 5 MB. Export a smaller version and try again.");
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      setImg(im);
      setName(file.name);
      setZoom(1);
      setOff({ x: 0, y: 0 });
    };
    im.onerror = () => setErr("That image could not be read. Try exporting it again as PNG.");
    im.src = url;
  };

  const render = useCallback(() => {
    const c = out.current, b = big.current;
    if (!c || !b) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#16110e";
    ctx.fillRect(0, 0, W, H);
    if (img) {
      const cover = Math.max(W / img.naturalWidth, H / img.naturalHeight) * zoom;
      const iw = img.naturalWidth * cover, ih = img.naturalHeight * cover;
      const ox = ((W - iw) / 2) * (1 - off.x), oy = ((H - ih) / 2) * (1 - off.y);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, ox, oy, iw, ih);
    }
    const bctx = b.getContext("2d")!;
    bctx.imageSmoothingEnabled = false;
    bctx.clearRect(0, 0, b.width, b.height);
    bctx.drawImage(c, 0, 0, b.width, b.height);
  }, [img, zoom, off, W, H]);

  useEffect(() => {
    render();
    if (!img || !out.current) return onChange(null, null);
    const c = out.current;
    const t = setTimeout(() => c.toBlob((bl) => onChange(bl, c.toDataURL("image/png")), "image/png"), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, img]);

  useEffect(() => {
    const f = frame.current;
    if (!f || !img) return;
    let start: { x: number; y: number; ox: number; oy: number } | null = null;
    const down = (e: PointerEvent) => {
      f.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      const cover = Math.max(W / img.naturalWidth, H / img.naturalHeight) * zoom;
      const ovx = Math.max(1, (img.naturalWidth * cover - W) / 2) * k;
      const ovy = Math.max(1, (img.naturalHeight * cover - H) / 2) * k;
      setOff({
        x: Math.max(-1, Math.min(1, start.ox + (e.clientX - start.x) / ovx)),
        y: Math.max(-1, Math.min(1, start.oy + (e.clientY - start.y) / ovy)),
      });
    };
    const up = () => (start = null);
    f.addEventListener("pointerdown", down);
    f.addEventListener("pointermove", move);
    f.addEventListener("pointerup", up);
    return () => {
      f.removeEventListener("pointerdown", down);
      f.removeEventListener("pointermove", move);
      f.removeEventListener("pointerup", up);
    };
  }, [img, off, zoom, W, H, k]);

  return (
    <div>
      <div className="flex items-end gap-4">
        <div
          ref={frame}
          tabIndex={img ? 0 : -1}
          role={img ? "slider" : undefined}
          aria-label={img ? "Image position. Arrow keys move the image inside the frame." : undefined}
          aria-valuetext={img ? `offset ${off.x.toFixed(1)}, ${off.y.toFixed(1)}` : undefined}
          onKeyDown={(e) => {
            const d = 0.1;
            const m: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
            if (!m[e.key]) return;
            e.preventDefault();
            setOff((o) => ({ x: Math.max(-1, Math.min(1, o.x + m[e.key][0])), y: Math.max(-1, Math.min(1, o.y + m[e.key][1])) }));
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) load(f);
          }}
          className={`relative shrink-0 touch-none ${img ? "cursor-move" : ""} ${drag ? "ring-2 ring-cone" : "ring-1 ring-char"}`}
          style={{ width: dw, height: dh }}
        >
          <canvas ref={big} width={dw * 2} height={dh * 2} className="absolute inset-0 h-full w-full" style={{ imageRendering: "pixelated" }} aria-hidden />
          {!img && (
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,#16110e_0_6px,#1c1714_6px_12px)] text-[0.82rem] text-ash hover:text-heat"
            >
              <span className="flex flex-col items-center gap-1 px-2 text-center">
                <IconUpload size={20} />
                {dw > 90 ? "Drop or choose an image" : "Add"}
              </span>
            </button>
          )}
        </div>
        <figure className="min-w-0">
          <canvas ref={out} width={W} height={H} className="block max-w-full ring-1 ring-char" style={{ width: Math.min(W, 140), imageRendering: "pixelated" }} aria-hidden />
          <figcaption className="num mt-1.5 text-[0.7rem] text-ash">
            {W}×{H} px{W <= 140 ? ", actual size" : ""}
          </figcaption>
        </figure>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        aria-label="Choose an image for your ad"
        onChange={(e) => e.target.files?.[0] && load(e.target.files[0])}
      />
      {img && (
        <div className="mt-3 flex items-center gap-3">
          <label className="text-[0.82rem] text-ash" htmlFor="zoom">
            Zoom
          </label>
          <input id="zoom" type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(+e.target.value)} className="flex-1 accent-[#ff6400]" />
          <button type="button" className="text-[0.82rem] text-ash underline underline-offset-2 hover:text-heat" onClick={() => input.current?.click()}>
            Replace
          </button>
        </div>
      )}
      {name && <p className="mt-1 truncate text-[0.75rem] text-ash">{name}</p>}
      {err && (
        <p className="mt-2 text-[0.85rem] text-flame" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
