import type { Metadata } from "next";
import { BurnsPage } from "@/components/burns/BurnsPage";
import { Footer } from "@/components/ui/Footer";

export const metadata: Metadata = { title: "Buyback vault", description: "The buyback vault balance, the treasury split, and who holds the most of the wall." };

export default function Page() {
  return (
    <>
      <BurnsPage />
      <Footer />
    </>
  );
}
