import { createTranslator } from "../../i18n/catalog";
import type { Locale } from "../../contracts/locale";

/**
 * Terms of service — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Content is Legacy's own terms, served from the ported `terms` chunk
 * (52 keys/loc). NOTE: Legacy's `terms/index.html` shipped as an EMPTY file
 * (0 bytes @edede31) while its catalog carried the full document — the words
 * were defined, the page was never rendered. Modern renders what Legacy
 * DEFINED (the chunk), which is the capability, not the broken artifact.
 */
/** Legacy's document order: service → acceptance → account → payments → risk →
 *  data → changes → contact (the toc_* keys pin this order @edede31). */
const SECTIONS: readonly { title: string; body?: string; items?: readonly string[] }[] = [
  { title: "pages.terms.p05.service_title", body: "pages.terms.p05.service_body" },
  { title: "pages.terms.p05.accept_title", body: "pages.terms.p05.accept_body" },
  {
    title: "pages.terms.p05.account_title",
    items: [
      "pages.terms.p05.account_1",
      "pages.terms.p05.account_2",
      "pages.terms.p05.account_3",
      "pages.terms.p05.account_4",
    ],
  },
  { title: "pages.terms.p05.payments_title", body: "pages.terms.p05.payments_body" },
  { title: "pages.terms.p05.risk_title", body: "pages.terms.p05.risk_body" },
  { title: "pages.terms.p05.data_title", body: "pages.terms.p05.data_body" },
  { title: "pages.terms.p05.changes_title", body: "pages.terms.p05.changes_body" },
  { title: "pages.terms.p05.contact_title", body: "pages.terms.p05.contact_body" },
];

export function TermsDocument({ locale }: { readonly locale: Locale }) {
  const t = createTranslator(locale, ["common", "terms"]);
  return (
    <main className="legal-shell">
      <header className="legal-top">
        <a href="/" className="legal-brand">VELORA</a>
        <a href="/" className="legal-back">{t("pages.terms.p05.back_home")}</a>
      </header>
      <section className="legal-hero">
        <p className="legal-eyebrow">{t("pages.terms.p05.breadcrumb")}</p>
        <h1>{t("pages.terms.p05.hero_line_1")}</h1>
        <p className="legal-lead">{t("pages.terms.p05.hero_line_2")}</p>
        <p className="muted-xs">{t("pages.terms.p05.document_version")} · {t("pages.terms.p05.version_1")} · {t("pages.terms.p05.date")}</p>
      </section>
      <article className="legal-doc">
        <p className="legal-intro">{t("pages.terms.p05.hero_intro")}</p>
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
      <footer className="legal-footer">
        <p className="muted-xs">{t("pages.terms.p05.notice")}</p>
      </footer>
    </main>
  );
}
