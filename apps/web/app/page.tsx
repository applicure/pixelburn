import { Hero } from "@/components/landing/Hero";
import { Ticker } from "@/components/landing/Ticker";
import { Era } from "@/components/landing/Era";
import { MoneyFlow } from "@/components/landing/MoneyFlow";
import { PayWithToken } from "@/components/landing/PayWithToken";
import { Controller } from "@/components/landing/Controller";
import { AuctionTeaser } from "@/components/landing/AuctionTeaser";
import { Faq } from "@/components/landing/Faq";
import { Footer } from "@/components/ui/Footer";

export default function Home() {
  return (
    <>
      <main id="main">
        <Hero />
        <Ticker />
        <Era />
        <MoneyFlow />
        <PayWithToken />
        <Controller />
        <AuctionTeaser />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
