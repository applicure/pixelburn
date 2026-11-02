"use client";
/**
 * WebGL hero: 10,000 instanced tiles (one per 10×10 block) rise as embers and settle
 * into the live billboard. Sold blocks sample the real canvas texture; unsold blocks
 * stay as unfired clay. Cursor heats the tiles under it; new purchases flash white-hot.
 * Loaded lazily (three is ~150 kB gz) and never mounted for reduced motion.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GRID } from "@/lib/config";
import { getCanvas, onLiveEvent, useLive } from "@/lib/store";

const VERT = /* glsl */ `
  in vec2 aGrid;
  in float aSeed;
  uniform float uProgress;
  uniform float uTime;
  uniform vec2 uMouse;
  uniform float uHover;
  uniform vec4 uFlash;
  uniform float uFlashT;
  out vec2 vUv;
  out float vHeat;
  out float vGlow;
  out vec2 vGrid;
  out float vSeed;

  void main() {
    vUv = uv;
    vGrid = aGrid;
    vSeed = aSeed;
    float delay = (aGrid.y / 100.0) * 0.38 + aSeed * 0.42;
    float t = clamp((uProgress * 1.75 - delay) / 0.9, 0.0, 1.0);
    float e = 1.0 - pow(1.0 - t, 3.0);

    vec3 target = vec3(aGrid.x - 49.5, 49.5 - aGrid.y, 0.0);
    float s2 = fract(aSeed * 7.13);
    vec3 start = vec3((aSeed - 0.5) * 150.0 + sin(aSeed * 91.0) * 24.0, -92.0 - s2 * 70.0, 18.0 + fract(aSeed * 3.7) * 70.0);
    vec3 p = mix(start, target, e);
    p.x += sin(t * 3.14159) * (fract(aSeed * 13.1) - 0.5) * 36.0;
    p.z += sin(t * 3.14159) * 14.0;

    float d = length(target.xy - uMouse);
    float bump = exp(-d * d / 55.0) * uHover;
    float inFlash = step(uFlash.x, aGrid.x) * step(aGrid.x, uFlash.x + uFlash.z - 1.0)
                  * step(uFlash.y, aGrid.y) * step(aGrid.y, uFlash.y + uFlash.w - 1.0);
    float fl = inFlash * uFlashT;
    p.z += (bump * 4.0 + fl * 9.0) * e;

    float ang = (1.0 - e) * (aSeed - 0.5) * 9.0;
    float sc = mix(0.42, 1.0, e) * (1.0 + fl * 0.12);
    vec2 q = position.xy * sc;
    q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;

    vHeat = 1.0 - smoothstep(0.55, 1.0, t);
    vGlow = bump + fl * 1.6;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p + vec3(q, 0.0), 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  layout(location = 0) out vec4 fragColor;
  uniform sampler2D uTex;
  uniform float uTime;
  uniform float uReady;
  in vec2 vUv;
  in float vHeat;
  in float vGlow;
  in vec2 vGrid;
  in float vSeed;

  vec3 ramp(float h) {
    vec3 cherry = vec3(0.70, 0.125, 0.055);
    vec3 flame  = vec3(1.0, 0.357, 0.078);
    vec3 cone   = vec3(1.0, 0.76, 0.24);
    vec3 white  = vec3(1.0, 0.965, 0.91);
    vec3 c = mix(cherry, flame, smoothstep(0.0, 0.35, h));
    c = mix(c, cone, smoothstep(0.35, 0.7, h));
    return mix(c, white, smoothstep(0.7, 1.0, h));
  }

  void main() {
    vec2 tuv = vec2((vGrid.x + vUv.x) / 100.0, (vGrid.y + 1.0 - vUv.y) / 100.0);
    vec4 tex = texture(uTex, tuv);
    float sold = texture(uTex, (vGrid + 0.5) / 100.0).a * uReady;

    // unfired clay tile with a 1px kiln-wash edge
    vec2 edge = min(vUv, 1.0 - vUv);
    float border = step(0.09, min(edge.x, edge.y));
    float flick = 0.5 + 0.5 * sin(uTime * (0.7 + vSeed * 1.3) + vSeed * 40.0);
    vec3 clay = mix(vec3(0.035, 0.028, 0.024), vec3(0.085, 0.066, 0.056), border);
    clay += vec3(1.0, 0.36, 0.08) * 0.035 * flick * border;

    vec3 fired = mix(clay, tex.rgb, sold);
    vec3 ember = ramp(clamp(vHeat * 1.15 - vSeed * 0.15, 0.0, 1.0));
    vec3 c = mix(fired, ember, smoothstep(0.02, 0.5, vHeat));
    c += ramp(0.55) * vGlow * 0.22;
    c = mix(c, vec3(1.0, 0.96, 0.9), clamp(vGlow - 1.0, 0.0, 1.0) * 0.6);
    float alpha = mix(1.0, 0.85, vHeat);
    fragColor = vec4(c, alpha);
  }
`;

const EMBER_VERT = /* glsl */ `
  in float aSeed;
  uniform float uTime;
  uniform float uPixel;
  out float vLife;
  out float vSeed;
  void main() {
    float speed = 5.0 + aSeed * 9.0;
    float life = fract(uTime * speed / 160.0 + aSeed * 17.0);
    vLife = life;
    vSeed = aSeed;
    vec3 p = vec3(
      (fract(aSeed * 31.7) - 0.5) * 120.0 + sin(uTime * 0.6 + aSeed * 50.0) * 4.0 * life,
      -70.0 + life * 150.0,
      (fract(aSeed * 5.3) - 0.2) * 40.0
    );
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uPixel * (0.6 + fract(aSeed * 9.1) * 1.6) * (1.0 - life) * (260.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const EMBER_FRAG = /* glsl */ `
  precision highp float;
  layout(location = 0) out vec4 fragColor;
  in float vLife;
  in float vSeed;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (max(abs(c.x), abs(c.y)) > 0.5) discard;
    vec3 hot = mix(vec3(1.0, 0.85, 0.5), vec3(1.0, 0.36, 0.08), vLife);
    hot = mix(hot, vec3(0.7, 0.12, 0.05), smoothstep(0.6, 1.0, vLife));
    fragColor = vec4(hot, (1.0 - vLife) * 0.9);
  }
`;

export default function KilnScene({ onReady, assembled = false }: { onReady?: () => void; assembled?: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const version = useLive((s) => s.canvasVersion);
  const ready = useLive((s) => s.ready);
  const texRef = useRef<THREE.CanvasTexture | null>(null);
  const uniRef = useRef<Record<string, THREE.IUniform> | null>(null);

  useEffect(() => {
    if (texRef.current) texRef.current.needsUpdate = true;
    if (uniRef.current && ready) uniRef.current.uReady.value = 1;
  }, [version, ready]);

  useEffect(() => {
    const mount = mountRef.current;
    const src = getCanvas();
    if (!mount || !src) return;

    const isSmall = window.innerWidth < 768;
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isSmall ? 1.75 : 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 1000);
    const group = new THREE.Group();
    scene.add(group);

    const tex = new THREE.CanvasTexture(src);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    texRef.current = tex;

    // instanced tiles
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    geo.setAttribute("uv", base.getAttribute("uv"));
    const N = GRID * GRID;
    const grid = new Float32Array(N * 2);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      grid[i * 2] = i % GRID;
      grid[i * 2 + 1] = Math.floor(i / GRID);
      seed[i] = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    }
    geo.setAttribute("aGrid", new THREE.InstancedBufferAttribute(grid, 2));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = N;

    const uniforms: Record<string, THREE.IUniform> = {
      uTex: { value: tex },
      uProgress: { value: 0 },
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(999, 999) },
      uHover: { value: 0 },
      uFlash: { value: new THREE.Vector4(-10, -10, 0, 0) },
      uFlashT: { value: 0 },
      uReady: { value: ready ? 1 : 0 },
    };
    uniRef.current = uniforms;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite: true,
    });
    const tiles = new THREE.Mesh(geo, mat);
    tiles.frustumCulled = false;
    group.add(tiles);

    // embers
    const EN = isSmall ? 160 : 360;
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(EN * 3), 3));
    const eSeed = new Float32Array(EN);
    for (let i = 0; i < EN; i++) eSeed[i] = Math.random();
    eGeo.setAttribute("aSeed", new THREE.BufferAttribute(eSeed, 1));
    const eUni = { uTime: { value: 0 }, uPixel: { value: renderer.getPixelRatio() } };
    const eMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      uniforms: eUni,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const embers = new THREE.Points(eGeo, eMat);
    embers.frustumCulled = false;
    scene.add(embers);

    // sizing: fit the 100-unit plane with a margin
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const fit = 50 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const fitW = fit / Math.min(1, camera.aspect);
      camera.position.set(0, 0, Math.max(fit, fitW) * 1.06);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // pointer → plane coordinates
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const plane = new THREE.Plane();
    const hit = new THREE.Vector3();
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
    let hoverTarget = 0;
    const onMove = (e: PointerEvent) => {
      const r = mount.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      tilt.tx = ndc.y * -0.09;
      tilt.ty = ndc.x * 0.13;
      ray.setFromCamera(ndc, camera);
      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion), group.position);
      if (ray.ray.intersectPlane(plane, hit)) {
        const local = group.worldToLocal(hit.clone());
        uniforms.uMouse.value.set(local.x, local.y);
        hoverTarget = Math.abs(local.x) < 52 && Math.abs(local.y) < 52 ? 1 : 0;
      }
    };
    const onLeave = () => {
      hoverTarget = 0;
      tilt.tx = 0;
      tilt.ty = 0;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    mount.addEventListener("pointerleave", onLeave);

    // purchases flash white-hot on the hero
    let flashStart = -1;
    const off = onLiveEvent((f) => {
      if (f.type !== "purchase") return;
      uniforms.uFlash.value.set(f.x, f.y, f.w, f.h);
      flashStart = performance.now();
    });

    let visible = true;
    const io = new IntersectionObserver(([en]) => (visible = en.isIntersecting), { threshold: 0 });
    io.observe(mount);

    const t0 = performance.now();
    let raf = 0;
    let readyFired = false;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) return;
      const t = (now - t0) / 1000;
      uniforms.uTime.value = t;
      eUni.uTime.value = t;
      // assembly: starts once data is ready, 3.4s, expo-out feel lives in the shader
      const startAt = uniforms.uReady.value ? 0.15 : 99;
      uniforms.uProgress.value = assembled ? 1 : Math.min(1, Math.max(0, (t - startAt) / 3.4));
      uniforms.uHover.value += (hoverTarget - uniforms.uHover.value) * 0.08;
      if (flashStart > 0) {
        const ft = (now - flashStart) / 1000;
        uniforms.uFlashT.value = ft < 0.15 ? ft / 0.15 : Math.max(0, 1 - (ft - 0.15) / 1.6);
        if (ft > 2) flashStart = -1;
      }
      tilt.x += (tilt.tx - tilt.x) * 0.06;
      tilt.y += (tilt.ty - tilt.y) * 0.06;
      group.rotation.set(tilt.x - 0.05, tilt.y - 0.11, 0);
      renderer.render(scene, camera);
      if (!readyFired && uniforms.uReady.value && uniforms.uProgress.value > 0.02) {
        readyFired = true;
        onReady?.();
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      off();
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      mount.removeEventListener("pointerleave", onLeave);
      geo.dispose();
      base.dispose();
      mat.dispose();
      eGeo.dispose();
      eMat.dispose();
      tex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      texRef.current = null;
      uniRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden />;
}
