import type { Metadata } from "next";
import { Suspense } from "react";
import { AuctionPage } from "@/components/auction/AuctionPage";
import { Footer } from "@/components/ui/Footer";

export const metadata: Metadata = { title: "Final auction", description: "The last 1% of the billboard is auctioned for 72 hours and the whole winning bid burns." };

export default function Page() {
  return (
    <>
      <Suspense fallback={<main className="min-h-screen pt-14" />}>
        <AuctionPage />
      </Suspense>
      <Footer />
    </>
  );
}
