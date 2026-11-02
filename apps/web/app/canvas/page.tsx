import type { Metadata } from "next";
import { Suspense } from "react";
import { CanvasApp } from "@/components/canvas/CanvasApp";

export const metadata: Metadata = {
  title: "Canvas",
  description: "Explore the live 1000×1000 billboard and buy free blocks.",
};

export default function CanvasPage() {
  return (
    <main id="main">
      <Suspense fallback={<div className="fixed inset-0 bg-kiln" />}>
        <CanvasApp />
      </Suspense>
    </main>
  );
}
