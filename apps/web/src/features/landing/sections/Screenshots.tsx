// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";

export function Screenshots({ l }: { l: LandingI18n }) {
  const { t, ta } = l;
  return (
    <>
      <section className="sec-pt-30" id="screenshots">
        {" "}
        <div className="wrap">
          {" "}
          <div className="sec-head reveal">
            {" "}
            <span className="eyebrow">{t("common.screenshots.17ef6055")}</span>
            {" "}
            <h2 className="sec-title">
              <span>{t("common.a.look.at.the.684c968d")}</span>
              {" "}
              <span className="gold">{t("common.real.product.0fad3ec6")}</span>
            </h2>
            {" "}
            <p className="sec-sub">{t("common.from.data.engine.to.mobile.app.each.e617dddb")}</p>
            {" "}
          </div>
          {" "}
          <div className="shots grid-stagger">
            {" "}
            <figure className="shot tilt reveal">
              {" "}
              <div className="shot-img">
                <img alt={ta("pages.landing.velora.ai.coach.513e5dc6")} src="/landing/ai-coach.jpg" />
                <span className="shot-tag">{t("common.v1.0.ai.coach.adc75683")}</span>
              </div>
              {" "}
              <figcaption>
                <b>{t("common.ai.trading.coach.15142b84")}</b>
                <span>{t("common.trading.behavior.analysis.overtrading.and.revenge.trading.8e75a818")}</span>
              </figcaption>
              {" "}
            </figure>
            {" "}
            <figure className="shot tilt reveal">
              {" "}
              <div className="shot-img">
                <img alt={ta("pages.landing.velora.multi.account.portfolio.a10666db")} src="/landing/portfolio.jpg" />
                <span className="shot-tag">{t("common.v1.5.portfolio.90f84c9f")}</span>
              </div>
              {" "}
              <figcaption>
                <b>{t("common.portfolio.prop.firm.3dac6241")}</b>
                <span>{t("common.multi.account.aggregation.currency.normalization.and.real.976ab0ac")}</span>
              </figcaption>
              {" "}
            </figure>
            {" "}
            <figure className="shot tilt reveal">
              {" "}
              <div className="shot-img">
                <img alt={ta("pages.landing.velora.mobile.app.2f750a8e")} src="/landing/mobile.jpg" />
                <span className="shot-tag">{t("common.v2.0.mobile.87e90d62")}</span>
              </div>
              {" "}
              <figcaption>
                <b>{t("common.mobile.app.e686a278")}</b>
                <span>{t("common.ios.and.android.with.real.time.trade.c876d8dd")}</span>
              </figcaption>
              {" "}
            </figure>
            {" "}
            <figure className="shot tilt reveal">
              {" "}
              <div className="shot-img">
                <img alt={ta("pages.landing.velora.data.engine.1182b028")} src="/landing/data-engine.jpg" />
                <span className="shot-tag">{t("common.v0.1.engine.90dcc237")}</span>
              </div>
              {" "}
              <figcaption>
                <b>{t("common.data.engine.sync.433f15a0")}</b>
                <span>{t("common.mt4.mt5.live.sync.with.aes.256.3a084a9d")}</span>
              </figcaption>
              {" "}
            </figure>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
    </>
  );
}
