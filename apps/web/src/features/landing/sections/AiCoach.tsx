// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";
import { AiChat } from "../AiChat";
export function AiCoach({ l }: { l: LandingI18n }) {
  const { t, ta, d } = l;
  return (
    <>
      <section className="sec-pt-30" id="ai">
        {" "}
        <div className="wrap">
          {" "}
          <div className="sec-head reveal">
            {" "}
            <span className="eyebrow">{t("common.ai.features.81a96372")}</span>
            {" "}
            <h2 className="sec-title">
              <span>{t("common.ask.a.coach.that.7c111138")}</span>
              {" "}
              <span className="gold">{t("common.understands.your.trades.84daeabc")}</span>
            </h2>
            {" "}
            <p className="sec-sub">{t("common.velora.ai.is.trained.on.your.live.2cb5880e")}</p>
            {" "}
          </div>
          {" "}
          <div className="ai-wrap reveal">
            {" "}
            <div className="ai-shell">
              {" "}
              <div className="ai-glow" />
              {" "}
              <div className="ai-panel">
                {" "}
                <div className="ai-head">
                  {" "}
                  <div className="ai-ava">
                    {" "}
                    <svg fill="none" viewBox="0 0 24 24">
                      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" fill="#e9c45c" />
                      <circle cx="19" cy="19" fill="#f7e3a1" r="2.2" />
                    </svg>
                    {" "}
                  </div>
                  {" "}
                  <div>
                    {" "}
                    <b>
                      <span>{t("common.velora.ai.b52f5388")}</span>
                      {" "}
                      <span className="ai-beta">
                        {"BETA"}
                      </span>
                    </b>
                    {" "}
                    <div className="ai-sub">{t("common.trained.on.your.live.journal.50.trades.ae8c9080")}</div>
                    {" "}
                  </div>
                  {" "}
                  <span className="ai-live">
                    <span className="pulse-dot" />
                    <span>{t("common.analyzing.168d27d1")}</span>
                  </span>
                  {" "}
                </div>
                {" "}
                <AiChat locale={l.locale} copy={l.aiCopy()} greeting={l.ta("common.hi.i.m.your.trading.co.pilot.7c04af05")} />
                {" "}
                {/* moved into <AiChat/> */}
                {" "}
                {/* moved into <AiChat/> */}
                {" "}
                {/* moved into <AiChat/> */}
                {" "}
              </div>
              {" "}
              <aside className="ai-briefing" aria-label={ta("pages.landing.ai.briefing.aria")}>
                <div className="brief-head">
                  <b>{t("pages.landing.ai.briefing.title")}</b>
                  <span>{t("pages.landing.ai.briefing.live")}</span>
                </div>
                <div className="brief-stat">
                  <label>{t("pages.landing.ai.briefing.behavior_pattern")}</label>
                  <b className="warn">{t("pages.landing.ai.briefing.early_exit")}</b>
                </div>
                <div className="brief-stat">
                  <label>{t("pages.landing.ai.briefing.best_window")}</label>
                  <b>
                    {d("09:00 — 12:00")}
                  </b>
                </div>
                <div className="brief-stat">
                  <label>{t("pages.landing.ai.briefing.discipline_level")}</label>
                  <b className="gold">
                    {d("82%")}
                  </b>
                </div>
                <div className="brief-insight">
                  <small>{t("pages.landing.ai.briefing.weekly_insight")}</small>
                  <p>{t("pages.landing.ai.briefing.insight")}</p>
                  <div className="brief-action">
                    <span>{t("pages.landing.ai.briefing.suggested_action")}</span>
                    <p>{t("pages.landing.ai.briefing.action")}</p>
                  </div>
                  <button data-ai-insight="" type="button">{t("pages.landing.ai.briefing.related_trades")}</button>
                </div>
              </aside>
              {" "}
              <div className="ai-float f1">
                {" "}
                <span className="fl-icon warn">
                  <svg fill="none" height="13" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="13">
                    <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
                  </svg>
                </span>
                {" "}
                <span>{t("common.revenge.trading.detected.94.af06be30")}</span>
                {" "}
              </div>
              {" "}
              <div className="ai-float f2">
                {" "}
                <span className="fl-icon ok">
                  <svg fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24" width="13">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                {" "}
                <span>{t("common.best.session.09.00.12.00.utc.fbaec34a")}</span>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
            <div className="ai-cards grid-stagger">
              {" "}
              <div className="ai-card reveal">
                {" "}
                <span className="vtag">{t("common.v1.0.e95ba052")}</span>
                {" "}
                <div className="ai-ic">
                  <svg fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
                  </svg>
                </div>
                {" "}
                <b>{t("common.ai.coach.insights.7d40d9c3")}</b>
                {" "}
                <p>{t("common.automatic.detection.of.overtrading.revenge.trading.and.d7288577")}</p>
                {" "}
              </div>
              {" "}
              <div className="ai-card reveal">
                {" "}
                <span className="vtag">{t("common.v3.0.83673b66")}</span>
                {" "}
                <div className="ai-ic">
                  <svg fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="12" cy="12" r="4.5" />
                    <circle cx="12" cy="12" fill="currentColor" r="1.2" />
                  </svg>
                </div>
                {" "}
                <b>{t("common.setup.evaluator.b332c97c")}</b>
                {" "}
                <p>{t("common.pre.entry.setup.scoring.with.ml.prediction.37a87d99")}</p>
                {" "}
              </div>
              {" "}
              <div className="ai-card reveal">
                {" "}
                <span className="vtag">{t("common.v1.5.745e4e7f")}</span>
                {" "}
                <div className="ai-ic">
                  <svg fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z" />
                  </svg>
                </div>
                {" "}
                <b>{t("common.risk.alerts.0f4dc8fb")}</b>
                {" "}
                <p>{t("common.real.time.alerts.when.approaching.risk.limits.1a47798c")}</p>
                {" "}
              </div>
              {" "}
              <div className="ai-card reveal">
                {" "}
                <span className="vtag">{t("common.v3.0.83673b66")}</span>
                {" "}
                <div className="ai-ic">
                  <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24">
                    <rect height="11" rx="3" width="6" x="9" y="2.5" />
                    <path d="M5 11a7 7 0 0014 0M12 18v3.5" />
                  </svg>
                </div>
                {" "}
                <b>
                  <span>{t("common.voice.co.pilot.b6c5a084")}</span>
                  {" "}
                  <span className="soon">{t("common.soon.7f3213d6")}</span>
                </b>
                {" "}
                <p>{t("common.voice.coach.in.sync.with.trades.alerts.c265998e")}</p>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
            <p className="ai-note">{t("common.interactive.demo.responses.are.simulated.based.on.74feb174")}</p>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
    </>
  );
}
