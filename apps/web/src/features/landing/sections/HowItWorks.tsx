// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";

export function HowItWorks({ l }: { l: LandingI18n }) {
  const { t, f } = l;
  return (
    <>
      <section id="how">
        {" "}
        <div className="wrap">
          {" "}
          <div className="sec-head reveal">
            {" "}
            <span className="eyebrow">{t("common.how.it.works.25f1d99e")}</span>
            {" "}
            <h2 className="sec-title">
              <span>{t("pages.landing.how.title.prefix")}</span>
              {" "}
              <span className="gold">{t("common.3.simple.steps.dd0fce6f")}</span>
              {" "}
              <span>{t("pages.landing.how.title.suffix")}</span>
            </h2>
            {" "}
          </div>
          {" "}
          <div className="steps grid-stagger">
            {" "}
            <div className="step reveal">
              {" "}
              <div className="num" data-format="number">{f("number", "1", {"maximumFractionDigits":0})}</div>
              {" "}
              <h3>{t("common.connect.account.1a187f08")}</h3>
              {" "}
              <p>{t("common.connect.your.mt4.mt5.account.via.metaapi.6af85f6c")}</p>
              {" "}
            </div>
            {" "}
            <div className="step reveal">
              {" "}
              <div className="num" data-format="number">{f("number", "2", {"maximumFractionDigits":0})}</div>
              {" "}
              <h3>{t("common.automatic.sync.23f2a4a6")}</h3>
              {" "}
              <p>{t("common.history.and.live.trades.are.recorded.automatically.18876623")}</p>
              {" "}
            </div>
            {" "}
            <div className="step reveal">
              {" "}
              <div className="num" data-format="number">{f("number", "3", {"maximumFractionDigits":0})}</div>
              {" "}
              <h3>{t("common.analyze.grow.a5acd58b")}</h3>
              {" "}
              <p>{t("common.the.analytics.engine.and.ai.trading.coach.bd36c8c7")}</p>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
    </>
  );
}
