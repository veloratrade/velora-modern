// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";

export function CtaBand({ l }: { l: LandingI18n }) {
  const { t, href } = l;
  return (
    <>
      <section className="cta-band" id="cta">
        {" "}
        <div className="wrap">
          {" "}
          <div className="cta-box reveal">
            {" "}
            <h2>
              <span>{t("common.ready.to.become.a.f5e10e44")}</span>
              {" "}
              <span className="gold">{t("common.better.trader.667f510f")}</span>
              {"?"}
            </h2>
            {" "}
            <p>{t("common.join.thousands.of.traders.improving.their.performance.b82d28a4")}</p>
            {" "}
            <div className="hero-ctas hero-ctas-center">
              {" "}
              <a className="btn btn-gold" href={href("/register")}>
                <span>{t("common.start.free.7af5f589")}</span>
                {" "}
                <svg fill="none" height="15" viewBox="0 0 24 24" width="15">
                  <path d="M5 12h14m0 0l-6-6m6 6l-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
                </svg>
                {" "}
              </a>
              {" "}
            </div>
            {" "}
            <div className="cta-note">{t("common.no.credit.card.required.free.forever.plan.e63e7112")}</div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
    </>
  );
}
