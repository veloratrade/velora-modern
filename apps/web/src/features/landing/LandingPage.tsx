import type { Locale } from "../../contracts";
import { AiChat } from "./AiChat";
import { HowModals } from "./HowModals";
import { LandingRuntime } from "./LandingRuntime";
import { ProductGallery } from "./ProductGallery";
import type { LandingI18n } from "./landingI18n";
import { Backdrop } from "./sections/Backdrop";
import { SiteHeader } from "./sections/SiteHeader";
import { Hero } from "./sections/Hero";
import { Stats } from "./sections/Stats";
import { Marquee } from "./sections/Marquee";
import { DashboardPreview } from "./sections/DashboardPreview";
import { Features } from "./sections/Features";
import { AiCoach } from "./sections/AiCoach";
import { HowItWorks } from "./sections/HowItWorks";
import { Screenshots } from "./sections/Screenshots";
import { SecurityBand } from "./sections/SecurityBand";
import { Pricing } from "./sections/Pricing";
import { Compare } from "./sections/Compare";
import { Faq } from "./sections/Faq";
import { Roadmap } from "./sections/Roadmap";
import { CtaBand } from "./sections/CtaBand";
import { SiteFooter } from "./sections/SiteFooter";

/**
 * Landing page composition — visual order identical to Legacy
 * localized index.html @edede31. All copy via l.t() (server), all
 * behavior via client islands (AiChat, HowModals, ProductGallery, LandingRuntime).
 * locale is the URL-contract locale ("/" = fa, "/en/" = en).
 */
export function LandingPage({ locale: _locale, l }: { locale: Locale; l: LandingI18n }) {
  void _locale;
  // Gallery and How need catalog copy; Ai already gets it via l.aiCopy() inside AiCoach.
  // We pass gallery copy to ProductGallery island.
  const gallery = l.galleryCopy();
  const how = l.howCopy();

  return (
    <>
      <Backdrop l={l} />
      <SiteHeader l={l} />
      <Hero l={l} />
      <Stats l={l} />
      <Marquee l={l} />
      <DashboardPreview l={l} />
      <Features l={l} />
      {/* AiCoach server shell + AiChat client island inside it */}
      <AiCoach l={l} />
      <HowItWorks l={l} />
      <Screenshots l={l} />
      <ProductGallery copy={gallery} />
      <SecurityBand l={l} />
      <Pricing l={l} />
      <Compare l={l} />
      <Faq l={l} />
      <Roadmap l={l} />
      <CtaBand l={l} />
      <SiteFooter l={l} />
      {/* Client behavior islands (no visual output except modals/overlays) */}
      <HowModals copy={how} />
      <LandingRuntime />
    </>
  );
}
