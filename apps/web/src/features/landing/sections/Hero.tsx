// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";

export function Hero({ l }: { l: LandingI18n }) {
  const { t, f, href } = l;
  return (
    <>
      <section className="hero" id="top">
        {" "}
        <canvas id="bg3d" />
        {" "}
        <div className="hero-inner">
          {" "}
          <div className="hero-text">
            {" "}
            <span className="badge eyebrow">{t("common.public.beta.v0.1.f1015bae")}</span>
            {" "}
            <h1>
              <span>{t("common.your.815d8a2a")}</span>
              {" "}
              <span className="gold-shimmer">{t("common.ai.trading.workspace.de423505")}</span>
            </h1>
            {" "}
            <p className="lead">{t("common.analyze.every.trade.improve.your.consistency.and.5de0df83")}</p>
            {" "}
            <p className="lead-sub">{t("common.analyze.every.trade.build.consistency.and.better.817d75c5")}</p>
            {" "}
            <div className="hero-ctas">
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
              <a className="btn btn-ghost" href="#dashboard">{t("common.view.dashboard.781b2033")}</a>
              {" "}
            </div>
            {" "}
            <div className="hero-chips">
              {" "}
              <span className="chip">
                <span className="dot" />
                {" "}
                <span>{t("common.live.auto.sync.3s.c3177737")}</span>
              </span>
              {" "}
              <span className="chip">
                <span className="dot" />
                {" "}
                <span>{t("common.analytics.100ms.359429a3")}</span>
              </span>
              {" "}
              <span className="chip">
                <span className="dot" />
                {" "}
                <span>{t("common.aes.256.gcm.encryption.84723cb6")}</span>
              </span>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <div className="hero-visual">
            {" "}
            <div className="v-ring" aria-hidden="true" />
            {" "}
            <div className="v-ring2" aria-hidden="true" />
            {" "}
            <div className="v-glow" />
            {" "}
            <div className="v-frame" id="vframe">
              {" "}
              <div className="db db-hero">
                {" "}
                <div className="db-chrome">
                  {" "}
                  <div className="db-dots">
                    <i />
                    <i />
                    <i />
                  </div>
                  {" "}
                  <span className="db-url">{t("common.app.velora.io.dashboard.1cded260")}</span>
                  {" "}
                  <span className="db-live">
                    <span className="pulse-dot" />
                    <span>{t("common.live.c94bf0b6")}</span>
                  </span>
                  {" "}
                </div>
                {" "}
                <div className="db-main">
                  {" "}
                  <div className="db-head">
                    {" "}
                    <div>
                      <h4>{t("common.performance.dashboard.27cc8506")}</h4>
                      <span className="sub">{t("common.mt5.1234567.auto.sync.active.34af4111")}</span>
                    </div>
                    {" "}
                    <div className="db-head-actions">
                      <span className="db-pill">{t("common.csv.report.abc12594")}</span>
                    </div>
                    {" "}
                  </div>
                  {" "}
                  <div className="db-kpis">
                    {" "}
                    <div className="kpi gauge-card">
                      {" "}
                      <span className="k-label">{t("common.ai.score.373b21a0")}</span>
                      {" "}
                      <div className="k-gauge">
                        {" "}
                        <svg viewBox="0 0 64 64">
                          <circle className="track" cx="32" cy="32" r="26" />
                          <circle className="fill" cx="32" cy="32" data-pct="78" r="26" />
                        </svg>
                        {" "}
                        <span className="v" data-format="number">{f("number", "78", {"maximumFractionDigits":0})}</span>
                        {" "}
                      </div>
                      {" "}
                    </div>
                    {" "}
                    <div className="kpi gauge-card">
                      {" "}
                      <span className="k-label">{t("common.risk.level.ae90a178")}</span>
                      {" "}
                      <div className="k-gauge">
                        {" "}
                        <svg viewBox="0 0 64 64">
                          <circle className="track" cx="32" cy="32" r="26" />
                          <circle className="fill" cx="32" cy="32" data-pct="32" r="26" />
                        </svg>
                        {" "}
                        <span className="v" data-format="number">{f("number", "32", {"maximumFractionDigits":0})}</span>
                        {" "}
                      </div>
                      {" "}
                    </div>
                    {" "}
                    <div className="kpi">
                      {" "}
                      <div className="k-head">
                        <span className="k-label">{t("common.profit.factor.4f05d40f")}</span>
                        <span className="k-trend" data-format="number">{f("number", "0.14", {"signDisplay":"always","minimumFractionDigits":2,"maximumFractionDigits":2})}</span>
                      </div>
                      {" "}
                      <div className="k-val">
                        <b data-format="number">{f("number", "1.82", {"minimumFractionDigits":2,"maximumFractionDigits":2})}</b>
                      </div>
                      {" "}
                      <div className="k-bar">
                        <i data-w="91" />
                      </div>
                      {" "}
                    </div>
                    {" "}
                    <div className="kpi">
                      {" "}
                      <div className="k-head">
                        <span className="k-label">{t("common.performance.consistency.bf71c316")}</span>
                        <span className="k-trend">{t("common.excellent.9c67b8eb")}</span>
                      </div>
                      {" "}
                      <div className="k-val">
                        <b data-format="percent">{f("percent", "0.86", {"maximumFractionDigits":0})}</b>
                      </div>
                      {" "}
                      <div className="k-bar">
                        <i data-w="86" />
                      </div>
                      {" "}
                    </div>
                    {" "}
                  </div>
                  {" "}
                  <div className="db-grid">
                    {" "}
                    <div className="db-panel" data-chart="">
                      {" "}
                      <div className="p-head">
                        <b>{t("common.equity.curve.cf3d44ce")}</b>
                        {" "}
                        <div className="tabs">
                          <button data-tab="day">{t("common.day.1d1c9f12")}</button>
                          <button className="on" data-tab="week">{t("common.week.52f397eb")}</button>
                          <button data-tab="month">{t("common.month.91b3d6d5")}</button>
                        </div>
                        {" "}
                      </div>
                      {" "}
                      <div className="eq-chart">
                        {" "}
                        <svg preserveAspectRatio="none" viewBox="0 0 620 200">
                          <line className="eq-gridline" x1="0" x2="620" y1="40" y2="40" />
                          <line className="eq-gridline" x1="0" x2="620" y1="80" y2="80" />
                          <line className="eq-gridline" x1="0" x2="620" y1="120" y2="120" />
                          <line className="eq-gridline" x1="0" x2="620" y1="160" y2="160" />
                          <path className="eq-area" d="M10,152 C55,134 85,146 125,126 C165,108 200,120 240,102 C280,86 315,96 355,78 C395,62 425,72 465,54 C505,38 545,44 610,26 L610,200 L10,200 Z" data-dday="M10,120 C45,132 62,94 92,102 C122,110 140,78 170,86 C200,94 222,62 252,70 C282,78 300,50 330,58 C360,66 382,42 412,50 C442,58 470,34 520,38 C560,41 585,30 610,28 L610,200 L10,200 Z" data-dmonth="M10,168 C60,152 90,160 130,140 C170,122 200,134 240,114 C280,96 310,106 350,86 C390,68 420,78 460,60 C500,42 540,50 610,28 L610,200 L10,200 Z" data-dweek="M10,152 C55,134 85,146 125,126 C165,108 200,120 240,102 C280,86 315,96 355,78 C395,62 425,72 465,54 C505,38 545,44 610,26 L610,200 L10,200 Z" fill="url(#lgArea)" />
                          <path className="eq-path" d="M10,152 C55,134 85,146 125,126 C165,108 200,120 240,102 C280,86 315,96 355,78 C395,62 425,72 465,54 C505,38 545,44 610,26" data-dday="M10,120 C45,132 62,94 92,102 C122,110 140,78 170,86 C200,94 222,62 252,70 C282,78 300,50 330,58 C360,66 382,42 412,50 C442,58 470,34 520,38 C560,41 585,30 610,28" data-dmonth="M10,168 C60,152 90,160 130,140 C170,122 200,134 240,114 C280,96 310,106 350,86 C390,68 420,78 460,60 C500,42 540,50 610,28" data-dweek="M10,152 C55,134 85,146 125,126 C165,108 200,120 240,102 C280,86 315,96 355,78 C395,62 425,72 465,54 C505,38 545,44 610,26" />
                          <circle className="eq-dot" cx="610" cy="26" r="4" />
                        </svg>
                        {" "}
                      </div>
                      {" "}
                    </div>
                    {" "}
                    <div className="db-panel">
                      {" "}
                      <div className="p-head">
                        <b>{t("common.today.s.journal.d9558458")}</b>
                        <span className="p-sub">{t("common.4.trades.4dcabf5b")}</span>
                      </div>
                      {" "}
                      <div className="tl-list">
                        {" "}
                        <div className="tl-row">
                          <span className="tl-dot up" />
                          <div className="tl-mid">
                            <b>{t("common.xauusd.buy.99fd3f2e")}</b>
                            <span data-format="time">{f("time", "09:42", undefined)}</span>
                          </div>
                          <div className="tl-tags">
                            <span className="tl-tag">
                              {"FVG"}
                            </span>
                            <span className="tl-tag">{t("common.patience.a0ecfb88")}</span>
                          </div>
                          <span className="tl-pnl up" data-format="currency">{f("currency", "235", {"maximumFractionDigits":0,"signDisplay":"always"}, "USD")}</span>
                        </div>
                        {" "}
                        <div className="tl-row">
                          <span className="tl-dot dn" />
                          <div className="tl-mid">
                            <b>{t("common.eurusd.sell.e06773a4")}</b>
                            <span data-format="time">{f("time", "11:07", undefined)}</span>
                          </div>
                          <div className="tl-tags">
                            <span className="tl-tag">{t("common.news.bba91630")}</span>
                            <span className="tl-tag bad">{t("common.revenge.15fd530d")}</span>
                          </div>
                          <span className="tl-pnl dn" data-format="currency">{f("currency", "-84", {"maximumFractionDigits":0}, "USD")}</span>
                        </div>
                        {" "}
                        <div className="tl-row">
                          <span className="tl-dot up" />
                          <div className="tl-mid">
                            <b>{t("common.gbpjpy.buy.dc98793b")}</b>
                            <span data-format="time">{f("time", "14:30", undefined)}</span>
                          </div>
                          <div className="tl-tags">
                            <span className="tl-tag">{t("common.breakout.996966cf")}</span>
                            <span className="tl-tag">{t("common.discipline.598e4e4b")}</span>
                          </div>
                          <span className="tl-pnl up" data-format="currency">{f("currency", "112", {"maximumFractionDigits":0,"signDisplay":"always"}, "USD")}</span>
                        </div>
                        {" "}
                        <div className="tl-row">
                          <span className="tl-dot up" />
                          <div className="tl-mid">
                            <b>{t("common.us30.sell.61d269c4")}</b>
                            <span data-format="time">{f("time", "16:55", undefined)}</span>
                          </div>
                          <div className="tl-tags">
                            <span className="tl-tag">{t("common.liquidity.24b3f592")}</span>
                          </div>
                          <span className="tl-pnl up" data-format="currency">{f("currency", "48", {"maximumFractionDigits":0,"signDisplay":"always"}, "USD")}</span>
                        </div>
                        {" "}
                      </div>
                      {" "}
                    </div>
                    {" "}
                  </div>
                  {" "}
                  <div className="psy-chips">
                    {" "}
                    <span className="psy-chip ok">{t("common.patience.discipline.05ecb0c8")}</span>
                    {" "}
                    <span className="psy-chip warn">{t("common.warning.early.exit.6f7f197a")}</span>
                    {" "}
                    <span className="psy-chip ok">{t("common.plan.compliance.24005864")}</span>
                    {" "}
                    <span className="psy-chip">{t("common.dominant.setup.fvg.939c5654")}</span>
                    {" "}
                  </div>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
            <div className="float-chip chip-1">
              {" "}
              <span className="pulse-dot" />
              {" "}
              <div>
                <b className="gold">{t("common.live.sync.57f5df8d")}</b>
                <span>{t("common.active.mt5.connection.38cf5aa6")}</span>
              </div>
              {" "}
            </div>
            {" "}
            <div className="float-chip chip-2">
              {" "}
              <svg fill="none" height="26" viewBox="0 0 24 24" width="26">
                <path d="M3 17l5-6 4 3 6-8" stroke="#e9c45c" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                <path d="M15 6h3v3" stroke="#e9c45c" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
              {" "}
              <div>
                <b className="gold" data-format="currency">{f("currency", "2345", {"signDisplay":"always","maximumFractionDigits":0}, "USD")}</b>
                <span>{t("common.net.p.l.this.week.0b33c64a")}</span>
              </div>
              {" "}
            </div>
            {" "}
            <div className="float-chip chip-3">
              {" "}
              <svg fill="none" height="26" viewBox="0 0 24 24" width="26">
                <circle cx="12" cy="12" r="9" stroke="#e9c45c" strokeWidth="1.8" />
                <path d="M12 7v5l3 3" stroke="#e9c45c" strokeLinecap="round" strokeWidth="1.8" />
              </svg>
              {" "}
              <div>
                <b className="gold">{t("common.win.rate.68.f4469265")}</b>
                <span>{t("common.based.on.142.trades.ca4ec35e")}</span>
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
        <div className="scroll-hint">
          <span>{t("common.scroll.1dd9cf1f")}</span>
          <i />
        </div>
        {" "}
      </section>
    </>
  );
}
