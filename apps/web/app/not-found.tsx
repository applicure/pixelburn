import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-[100svh] place-items-center px-4 pt-14">
      <div className="max-w-xl">
        <p className="num text-cone">404</p>
        <h1 className="mt-3 font-black text-[clamp(2.6rem,9vw,6rem)] [font-variation-settings:'wdth'_120]">Nothing here but ash.</h1>
        <p className="mt-4 text-heat/80">That page doesn&apos;t exist. The billboard does.</p>
        <Link href="/canvas" className="btn-fire mt-8">Open the canvas</Link>
      </div>
    </main>
  );
}
