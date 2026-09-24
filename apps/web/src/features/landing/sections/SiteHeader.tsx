// GENERATED ONCE from Legacy localized/en/index.html @edede31 by /tmp/conv/convert.py,
// then maintained by hand. Class names / structure are the visual contract (KEEP THE LOOK);
// all copy comes from the fa/en catalogs via t()/ta(); numbers via f(); literal text via d().
import type { LandingI18n } from "../landingI18n";
import { LocaleSwitcher } from "../LocaleSwitcher";
export function SiteHeader({ l }: { l: LandingI18n }) {
  const { t, ta, href } = l;
  return (
    <>
      <header id="header">
        {" "}
        <div className="nav">
          {" "}
          <a className="logo" href="#top">
            {" "}
            <span className="logo-mark">
              {" "}
              <svg aria-hidden="true" viewBox="0 0 64 64">
                <path d="M8 10L21 10L32 52L43 10L56 10L32 58Z" fill="none" stroke="#e8c45a" strokeWidth=".7" />
                <path d="M8 10L21 10L32 52L43 10L56 10L32 58Z" fill="url(#lgD)" />
                <path d="M21 10L32 52L32 58L8 10Z" fill="url(#lgD)" opacity=".55" />
                <path d="M43 10L32 52L32 58L56 10Z" fill="url(#lgA)" />
                <path d="M32 14V24M32 37V52" stroke="url(#lgC)" strokeWidth="2.6" />
                <rect fill="url(#lgC)" height="13" width="7" x="28.5" y="24" />
                <path d="M32 6.5L33.3 9.7L36.5 11L33.3 12.3L32 15.5L30.7 12.3L27.5 11L30.7 9.7Z" fill="#f7e3a1" />
              </svg>
              {" "}
            </span>
            {" "}
            <span className="logo-txt">
              <b>{t("common.velora.2e043621")}</b>
              <i>
                {"TRADING OS"}
              </i>
            </span>
            {" "}
          </a>
          {" "}
          <nav className="links" id="links">
            {" "}
            <a href="#features">{t("common.features.749b6518")}</a>
            {" "}
            <a href="#dashboard">{t("common.dashboard.2aea7aaf")}</a>
            {" "}
            <a href="#ai">{t("common.ai.834c1d93")}</a>
            {" "}
            <a href="#screenshots">{t("common.product.55407bd1")}</a>
            {" "}
            <div className="nav-dd">
              {" "}
              <button className="nav-dd-btn" aria-expanded="false" aria-haspopup="true">
                {" "}
                <span>{t("common.roadmap.44b96602")}</span>
                {" "}
                <svg className="chev" fill="none" height="12" viewBox="0 0 24 24" width="12">
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
                </svg>
                {" "}
              </button>
              {" "}
              <div className="dd-menu">
                {" "}
                <div className="dd-label">{t("common.coming.soon.a33ac742")}</div>
                {" "}
                <a className="dd-item" href="#screenshots">
                  {" "}
                  <span className="dd-ic">
                    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24">
                      <rect height="19" rx="2.4" width="10" x="7" y="2.5" />
                      <path d="M11 18.5h2" />
                    </svg>
                  </span>
                  {" "}
                  <span className="dd-tx">
                    <b>{t("common.mobile.app.e686a278")}</b>
                    <small>{t("common.ios.android.app.deaa8482")}</small>
                  </span>
                  {" "}
                  <span className="dd-badge">{t("common.soon.7f3213d6")}</span>
                  {" "}
                </a>
                {" "}
                <a className="dd-item" href="#ai">
                  {" "}
                  <span className="dd-ic">
                    <svg fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
                    </svg>
                  </span>
                  {" "}
                  <span className="dd-tx">
                    <b>{t("common.ai.coach.b06513b6")}</b>
                    <small>{t("common.ai.trading.coach.15142b84")}</small>
                  </span>
                  {" "}
                  <span className="dd-badge">{t("common.soon.7f3213d6")}</span>
                  {" "}
                </a>
                {" "}
                <a className="dd-item" href="#roadmap">
                  {" "}
                  <span className="dd-ic">
                    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
                      <circle cx="16" cy="8" r="2.2" />
                      <circle cx="10" cy="16" r="2.2" />
                    </svg>
                  </span>
                  {" "}
                  <span className="dd-tx">
                    <b>{t("common.strategy.builder.d642cabb")}</b>
                    <small>{t("common.strategy.builder.d642cabb")}</small>
                  </span>
                  {" "}
                  <span className="dd-badge">{t("common.soon.7f3213d6")}</span>
                  {" "}
                </a>
                {" "}
                <a className="dd-item" href="#features">
                  {" "}
                  <span className="dd-ic">
                    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                    </svg>
                  </span>
                  {" "}
                  <span className="dd-tx">
                    <b>{t("common.broker.integration.b65926bf")}</b>
                    <small>{t("common.broker.integration.b65926bf")}</small>
                  </span>
                  {" "}
                  <span className="dd-badge">{t("common.soon.7f3213d6")}</span>
                  {" "}
                </a>
                {" "}
                <div className="dd-foot">
                  {" "}
                  <a className="dd-all" href="#roadmap">
                    <span>{t("common.view.full.roadmap.c40d2d3a")}</span>
                    {" "}
                    <svg fill="none" height="13" viewBox="0 0 24 24" width="13">
                      <path d="M19 12H5m0 0l6-6m-6 6l6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                    </svg>
                    {" "}
                  </a>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
            <a href="#pricing">{t("common.pricing.661506b9")}</a>
            {" "}
            <a href={href("/blog/")}>{t("common.blog.4a829cc7")}</a>
            {" "}
            <a href="#faq">{t("common.faq.d874deb8")}</a>
            {" "}
            <a className="nav-login" href={href("/login")}>{t("common.login.e09e596b")}</a>
            {" "}
            <a className="btn btn-gold nav-cta" href={href("/register")}>
              <span>{t("common.get.started.2ad8d1a6")}</span>
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M5 12h14m0 0-6-6m6 6-6 6" />
              </svg>
            </a>
            {" "}
            <LocaleSwitcher locale={l.locale} label={l.ta("common.language")} placement="menu" />
          </nav>
          {" "}
          <LocaleSwitcher locale={l.locale} label={l.ta("common.language")} placement="header" />
      <button aria-label={ta("common.menu.1f381a4e")} id="nav-toggle">
        <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
          {" "}
        </div>
        {" "}
      </header>
    </>
  );
}
