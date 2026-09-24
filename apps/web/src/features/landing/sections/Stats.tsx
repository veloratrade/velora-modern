// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";

export function Stats({ l }: { l: LandingI18n }) {
  const { t, d } = l;
  return (
    <>
      <div className="stats">
        {" "}
        <div className="wrap stats-grid reveal">
          {" "}
          <div className="stat">
            <b data-count="3" data-unit="second">
              {d("0")}
            </b>
            <span>{t("common.live.webhook.sync.latency.1480fdd2")}</span>
          </div>
          {" "}
          <div className="stat">
            <b data-count="50" data-unit="millisecond">
              {d("0")}
            </b>
            <span>{t("common.native.mt4.mt5.ea.latency.1ab1c8b1")}</span>
          </div>
          {" "}
          <div className="stat">
            <b data-count="100" data-unit="millisecond">
              {d("0")}
            </b>
            <span>{t("common.interactive.analytics.render.703567c3")}</span>
          </div>
          {" "}
          <div className="stat">
            <b data-count="12" data-unit="month">
              {d("0")}
            </b>
            <span>{t("common.auto.sync.history.depth.337bf54e")}</span>
          </div>
          {" "}
          <div className="stat">
            <b>
              {d("AES-256")}
            </b>
            <span>{t("common.field.level.broker.data.encryption.c5e635ee")}</span>
          </div>
          {" "}
        </div>
        {" "}
      </div>
    </>
  );
}
