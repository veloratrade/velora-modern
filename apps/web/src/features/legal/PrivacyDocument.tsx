import { createTranslator } from "../../i18n/catalog";
import type { Locale } from "../../contracts/locale";

/**
 * Privacy policy — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Content is Legacy's own privacy policy, served from the ported `privacy`
 * chunk (93 keys/loc, byte copies of Legacy public/locales chunks @edede31).
 * The page STRUCTURE (hero → document header → numbered sections → CTA) is
 * the structure of Legacy's privacy/index.html, rebuilt with Modern
 * components. A public, static page (class C) — same as Legacy.
 */
const SECTIONS: readonly { title: string; body?: string; items?: readonly string[] }[] = [
  { title: "pages.privacy.p05.collection_title", body: "pages.privacy.p05.collection_body" },
  {
    title: "pages.privacy.p05.use_title",
    items: [
      "pages.privacy.p05.use_1",
      "pages.privacy.p05.use_2",
      "pages.privacy.p05.use_3",
      "pages.privacy.p05.use_4",
    ],
  },
  { title: "pages.privacy.p05.control_title", body: "pages.privacy.p05.control_body" },
  { title: "pages.privacy.p05.changes_title", body: "pages.privacy.p05.changes_body" },
  { title: "pages.privacy.p05.contact_title", body: "pages.privacy.p05.contact_body" },
];

export function PrivacyDocument({ locale }: { readonly locale: Locale }) {
  const t = createTranslator(locale, ["common", "privacy"]);
  return (
    <main className="legal-shell">
      <header className="legal-top">
        <a href="/" className="legal-brand">VELORA</a>
        <a href="/" className="legal-back">{t("pages.privacy.p05.back_home")}</a>
      </header>
      <section className="legal-hero">
        <p className="legal-eyebrow">{t("pages.privacy.p05.eyebrow")}</p>
        <h1>{t("pages.privacy.p05.hero_line_1")}</h1>
        <p className="legal-lead">{t("pages.privacy.p05.hero_line_2")}</p>
        <p className="muted-xs">{t("pages.privacy.p05.document_version")} · {t("pages.privacy.p05.version_1")} · {t("pages.privacy.p05.date")}</p>
      </section>
      <article className="legal-doc">
        <p className="legal-intro">{t("pages.privacy.p05.document_intro")}</p>
        {SECTIONS.map((s) => (
          <section key={s.title} className="legal-section">
            <h2>{t(s.title)}</h2>
            {s.body ? <p>{t(s.body)}</p> : null}
            {s.items ? (
              <ol>
                {s.items.map((k) => (
                  <li key={k}>{t(k)}</li>
                ))}
              </ol>
            ) : null}
          </section>
        ))}
      </article>
      <section className="legal-cta">
        <h2>{t("pages.privacy.p05.cta_title")}</h2>
        <p>{t("pages.privacy.p05.cta_body")}</p>
        <a className="btn-gold" href="/register">{t("pages.privacy.p05.cta_button")}</a>
      </section>
      <footer className="legal-footer">
        <p className="muted-xs">{t("pages.privacy.p05.copyright")}</p>
      </footer>
    </main>
  );
}
