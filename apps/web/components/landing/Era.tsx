"use client";
import { useEffect, useRef, useState } from "react";
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { paint2005 } from "./paint2005";
import { BRAND, HISTORY_2005 } from "@/lib/config";
import { fmtUsd } from "@/lib/format";

const FACTS = [
  { when: HISTORY_2005.launched, what: `${HISTORY_2005.founder} puts 1,000,000 pixels on sale at $1 each, in 10×10 blocks.` },
  { when: "Autumn 2005", what: "Brands, bands, casinos and strangers fill the grid as the press picks up the story." },
  { when: HISTORY_2005.soldOut, what: `Sold out. The last 1,000 pixels go to an eBay auction for ${fmtUsd(HISTORY_2005.ebayUsd)}.` },
  { when: "Total", what: `${fmtUsd(HISTORY_2005.raisedUsd)} raised. Twenty years on, a lot of those links are dead.` },
];

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uP;
uniform float uHeat;
uniform float uAspect;
in vec2 vUv;
out vec4 o;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*n2(p); p*=2.03; a*=.5; } return v; }
void main(){
  vec4 c = texture(uTex, vUv);
  float n = fbm(vUv * vec2(uAspect, 1.0) * 3.2);
  n = n * 0.72 + (1.0 - vUv.y) * 0.0 + vUv.y * 0.28;
  float t = uP * 1.18 - 0.06;
  float d = n - t;
  if (d < 0.0) discard;
  float scorch = smoothstep(0.0, 0.14, d);
  float edge = smoothstep(0.0, 0.022, d);
  vec3 toast = mix(c.rgb, c.rgb * vec3(0.78, 0.55, 0.32), uHeat);
  vec3 col = mix(vec3(0.10, 0.035, 0.015), toast, scorch);
  vec3 fire = mix(vec3(1.0, 0.961, 0.863), vec3(1.0, 0.392, 0.0), smoothstep(0.0, 0.016, d));
  col = mix(fire, col, edge);
  o = vec4(col, 1.0);
}`;
const VERT = `#version 300 es
in vec2 p; out vec2 vUv;
void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

function useBurnGL(canvasRef: React.RefObject<HTMLCanvasElement | null>, burn: MotionValue<number>, heat: MotionValue<number>, enabled: boolean) {
  const [ok, setOk] = useState<boolean | null>(null);
  const [near, setNear] = useState(false);
  // build the texture + GL program only when the section approaches the viewport
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !enabled) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: "100% 0px" });
    io.observe(cv);
    return () => io.disconnect();
  }, [canvasRef, enabled]);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !enabled || !near) return;
    const gl = cv.getContext("webgl2", { premultipliedAlpha: false, alpha: true });
    if (!gl) {
      setOk(false);
      return;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setOk(false);
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    const uP = gl.getUniformLocation(prog, "uP");
    const uHeat = gl.getUniformLocation(prog, "uHeat");
    const uAspect = gl.getUniformLocation(prog, "uAspect");
    const src = document.createElement("canvas");

    const upload = () => {
      const r = { width: cv.clientWidth, height: cv.clientHeight };
      if (!r.width) return;
      paint2005(src, r.width, r.height);
      cv.width = src.width;
      cv.height = src.height;
      gl.viewport(0, 0, cv.width, cv.height);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1f(uAspect, r.width / r.height);
      draw();
    };
    const draw = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uP, burn.get());
      gl.uniform1f(uHeat, heat.get());
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    const u1 = burn.on("change", schedule);
    const u2 = heat.on("change", schedule);
    const ro = new ResizeObserver(upload);
    ro.observe(cv);
    upload();
    setOk(true);
    return () => {
      u1();
      u2();
      ro.disconnect();
      cancelAnimationFrame(raf);
      gl.deleteTexture(tex);
      gl.deleteProgram(prog);
    };
  }, [canvasRef, burn, heat, enabled, near]);
  return ok;
}

function StaticWindow() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const r = { width: c.clientWidth, height: c.clientHeight };
      paint2005(c, r.width, r.height);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  return <canvas ref={ref} className="h-full w-full" aria-hidden />;
}

const RULES = [
  ["$1 a pixel, still.", "100×100 blocks of 10×10 px. You buy a rectangle, it shows your image and link, on-chain, on Solana."],
  ["Your payment is fuel.", `Half of every SOL goes to the treasury, half buys back ${BRAND.ticker} and burns it. Pay in ${BRAND.ticker} at 10% off and every token you pay is burned.`],
  ["Nothing link-rots.", "Images are stored on Arweave and the ad record lives on-chain. No server to switch off this time."],
] as const;

function Rules({ className = "" }: { className?: string }) {
  return (
    <div className={`space-y-5 text-[1rem] leading-relaxed text-heat/85 ${className}`}>
      {RULES.map(([h, p]) => (
        <p key={h}>
          <strong className="block font-display text-[1.3rem] font-extrabold text-heat [font-variation-settings:'wdth'_110]">{h}</strong>
          {p}
        </p>
      ))}
    </div>
  );
}

/** Lives inside the 2005 window's own frame, so it is only ever seen through burned holes. */
function Reveal2026() {
  return (
    <div className="@container absolute inset-0 flex flex-col justify-center bg-soot px-[6%]">
      <p className="num text-[clamp(0.75rem,1.6cqw,1rem)] text-cone">2026</p>
      <h2 className="mt-2 font-black leading-[0.9] [font-size:clamp(2.2rem,10.5cqw,7.5rem)] [font-variation-settings:'wdth'_118]">
        Same billboard.
        <br />
        Now it buys
        <br />
        and burns.
      </h2>
    </div>
  );
}

export function Era() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const burn = useTransform(scrollYProgress, [0.48, 0.86], [0, 1], { clamp: true });
  const heat = useTransform(scrollYProgress, [0.3, 0.6], [0, 1], { clamp: true });
  const winScale = useTransform(scrollYProgress, [0, 0.14, 0.5, 0.86], [0.9, 1, 1.02, 1.08]);
  const winY = useTransform(scrollYProgress, [0, 0.14], [60, 0]);
  // the reveal sits under the paper; only switch it on once the first hole can open
  const revealOpacity = useTransform(burn, [0, 0.01], [0, 1]);
  const factsOpacity = useTransform(scrollYProgress, [0.42, 0.5], [1, 0]);
  const rulesOpacity = useTransform(scrollYProgress, [0.87, 0.95], [0, 1]);
  const rulesY = useTransform(scrollYProgress, [0.87, 0.95], [24, 0]);
  const [fact, setFact] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => setFact(Math.max(0, Math.min(3, Math.floor((v - 0.08) / 0.1)))));
  const fallbackOpacity = useTransform(burn, [0, 1], [1, 0]);
  const gl = useBurnGL(glRef, burn, heat, !reduce);

  if (reduce) {
    return (
      <section className="py-24" aria-labelledby="era-title">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
          <h2 id="era-title" className="font-black text-[clamp(2.4rem,7vw,5.5rem)] [font-variation-settings:'wdth'_90]">
            2005: a kid sold the internet, one pixel at a time.
          </h2>
          <div className="mt-10 grid gap-10 lg:grid-cols-12">
            <ol className="space-y-6 lg:col-span-4">
              {FACTS.map((f) => (
                <li key={f.when}>
                  <span className="num text-[0.85rem] text-cone">{f.when}</span>
                  <p className="mt-1 text-heat/85">{f.what}</p>
                </li>
              ))}
            </ol>
            <div className="aspect-[4/3] w-full sepia-[.35] lg:col-span-8">
              <StaticWindow />
            </div>
          </div>
        </div>
        <div className="mx-auto mt-16 grid max-w-[1400px] gap-10 px-4 sm:px-6 lg:grid-cols-12">
          <div className="relative aspect-[4/3] lg:col-span-7">
            <Reveal2026 />
          </div>
          <Rules className="lg:col-span-5" />
        </div>
      </section>
    );
  }

  return (
    <>
    <section ref={ref} className="relative h-[420svh]" aria-labelledby="era-title">
      <div className="sticky top-0 flex h-[100svh] flex-col overflow-hidden pt-14">
        <div className="relative mx-auto grid w-full max-w-[1400px] flex-1 grid-cols-1 content-center gap-6 px-4 sm:px-6 lg:grid-cols-12 lg:gap-10">
          <div className="relative lg:col-span-4">
          <motion.div className="relative z-10" style={{ opacity: factsOpacity }}>
            <h2 id="era-title" className="font-black text-[clamp(2rem,6.2vw,4.4rem)] leading-[0.95] [font-variation-settings:'wdth'_78]">
              2005: a student sold the internet, one pixel at a time.
            </h2>
            <ol className="relative mt-6 hidden lg:block" aria-label="2005 timeline">
              {FACTS.map((f, i) => (
                <li
                  key={f.when}
                  className="grid grid-cols-[7.5rem_1fr] gap-4 border-t border-char py-3 transition-[opacity,color] duration-500"
                  style={{ opacity: i <= fact ? 1 : 0.22 }}
                >
                  <span className={`num pt-1 text-[0.8rem] ${i === fact ? "text-cone" : "text-ash"}`}>{f.when}</span>
                  <span className="text-[0.98rem] leading-snug text-heat/90">{f.what}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 min-h-[4.5em] text-[0.98rem] leading-snug text-heat/90 lg:hidden" aria-live="polite">
              <span className="num mr-2 text-[0.8rem] text-cone">{FACTS[fact].when}</span>
              {FACTS[fact].what}
            </p>
          </motion.div>
          {/* after the paper has burned away: the 2026 rules take the column (desktop) */}
          <motion.div className="absolute inset-0 hidden content-center lg:grid" style={{ opacity: rulesOpacity, y: rulesY }} aria-hidden>
            <Rules />
          </motion.div>
          </div>

          <motion.div
            className="relative aspect-[3/4] max-h-[62svh] w-full justify-self-center sm:aspect-[4/3] lg:col-span-8 lg:max-h-[78svh]"
            style={{ scale: winScale, y: winY }}
          >
            <motion.div className="absolute inset-0" style={{ opacity: revealOpacity }}>
              <Reveal2026 />
            </motion.div>
            <canvas
              ref={glRef}
              className="absolute inset-0 h-full w-full shadow-[0_40px_90px_-30px_rgba(0,0,0,.9)]"
              aria-hidden
            />
            {gl === false && (
              <motion.div className="absolute inset-0" style={{ opacity: fallbackOpacity }}>
                <StaticWindow />
              </motion.div>
            )}
          </motion.div>
        </div>
      </div>
    </section>
    {/* mobile: the rules follow as plain content once the story is done */}
    <div className="mx-auto max-w-[1400px] px-4 pb-8 sm:px-6 lg:hidden">
      <Rules />
    </div>
    </>
  );
}
