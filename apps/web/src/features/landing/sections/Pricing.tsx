// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";

export function Pricing({ l }: { l: LandingI18n }) {
  const { t, f, href } = l;
  return (
    <>
      <section id="pricing">
        {" "}
        <div className="wrap">
          {" "}
          <div className="sec-head reveal">
            {" "}
            <span className="eyebrow">{t("common.pricing.661506b9")}</span>
            {" "}
            <h2 className="sec-title">
              <span>{t("pages.landing.pricing.title.prefix")}</span>
              {" "}
              <span className="gold">{t("common.every.stage.of.your.growth.aa3e5831")}</span>
              {" "}
              <span>{t("pages.landing.pricing.title.suffix")}</span>
            </h2>
            {" "}
            <p className="sec-sub">{t("common.start.free.upgrade.to.professional.whenever.you.c6c74b6c")}</p>
            {" "}
          </div>
          {" "}
          <div className="price-grid grid-stagger">
            {" "}
            <div className="price-card tilt reveal">
              {" "}
              <h3>{t("common.free.3d88da0e")}</h3>
              {" "}
              <p className="desc">{t("common.to.get.started.and.explore.velora.c48f9738")}</p>
              {" "}
              <div className="price">
                <b data-format="currency">{f("currency", "0", {"maximumFractionDigits":0}, "USD")}</b>
                <span>{t("common.forever.5588655a")}</span>
              </div>
              {" "}
              <p className="price-note">{t("common.no.credit.card.required.5c2adccc")}</p>
              {" "}
              <ul>
                <li>{t("common.manual.trade.journaling.88f26185")}</li>
                <li>{t("common.connect.1.account.via.native.ea.914e9076")}</li>
                <li>{t("common.basic.calculations.win.rate.p.l.profit.2fe08aa1")}</li>
                <li>{t("common.one.account.one.platform.0332054f")}</li>
              </ul>
              {" "}
              <a className="btn btn-ghost" href={href("/register")}>{t("common.start.free.7af5f589")}</a>
              {" "}
            </div>
            {" "}
            <div className="price-card hot reveal">
              {" "}
              <span className="hot-badge">{t("common.most.popular.7a8cc941")}</span>
              {" "}
              <h3>{t("common.professional.ff595889")}</h3>
              {" "}
              <p className="desc">{t("common.for.serious.and.prop.traders.875e10c4")}</p>
              {" "}
              <div className="price">
                <b data-format="currency">{f("currency", "29", {"maximumFractionDigits":0}, "USD")}</b>
                <span>{t("common.monthly.6b4ea6e4")}</span>
              </div>
              {" "}
              <p className="price-note">{t("common.or.240.year.2.months.free.9253f888")}</p>
              {" "}
              <ul>
                <li>{t("common.everything.in.free.c69a0d32")}</li>
                <li>{t("common.metaapi.cloud.sync.unlimited.047383f0")}</li>
                <li>{t("common.advanced.analytics.engine.tagging.9cd63fb4")}</li>
                <li>{t("common.ai.trading.coach.with.weekly.insights.9fe5b04b")}</li>
                <li>{t("common.multi.account.portfolio.prop.monitor.12be1913")}</li>
                <li>{t("common.real.time.alerts.verified.profile.b67b1e8c")}</li>
              </ul>
              {" "}
              <a className="btn btn-gold" href={href("/checkout/?plan=professional")}>{t("common.start.14.day.trial.d9e08362")}</a>
              <div className="plan-trust">{t("pages.landing.pricing.trial_no_card")}</div>
              {" "}
            </div>
            {" "}
            <div className="price-card tilt reveal">
              {" "}
              <h3>{t("common.enterprise.f26c11f0")}</h3>
              {" "}
              <p className="desc">{t("common.for.prop.firms.and.brokers.7ac167c1")}</p>
              {" "}
              <div className="price">
                <b>{t("common.contact.4296bf4d")}</b>
                <span>{t("common.us.06720acd")}</span>
              </div>
              {" "}
              <p className="price-note">{t("common.custom.b2b.solution.2f89594e")}</p>
              {" "}
              <ul>
                <li>{t("common.white.label.with.your.brand.896dc858")}</li>
                <li>{t("common.public.trader.performance.verification.8e6fbe7d")}</li>
                <li>{t("common.peer.to.peer.copy.trading.engine.e1c13a5a")}</li>
                <li>{t("common.full.multi.tenant.isolation.20e4cbb5")}</li>
                <li>{t("common.enterprise.sla.dedicated.support.26db01e9")}</li>
              </ul>
              {" "}
              <a className="btn btn-ghost" href={href("/login")}>{t("common.talk.to.us.a50cba51")}</a>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <p className="foot-note">{t("common.secure.payment.via.stripe.14.day.money.fa558835")}</p>
          {" "}
        </div>
        {" "}
      </section>
    </>
  );
}
