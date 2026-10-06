import type { Metadata } from "next";
import Link from "next/link";
import { createTranslator } from "../../i18n/catalog";
import { BLOG_POSTS } from "./posts";

/**
 * Blog index — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's blog was five static marketing posts, fully catalog-driven (the
 * `blog` chunk carries the article content; the pages are its `data-i18n`
 * sequences). Modern renders the same five posts from the same catalog —
 * class B (editorial) in the locale contract, exactly as declared.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("fa", ["common", "blog"]);
  return {
    title: t("pages.blog.velora.blog.trading.journal.and.risk.management.68b13dc3", null, "وبلاگ VELORA | ژورنال معاملات و مدیریت ریسک"),
    alternates: {
      canonical: "https://veloratrade.ir/blog/",
      languages: { fa: "https://veloratrade.ir/blog/", en: "https://veloratrade.ir/en/blog/", "x-default": "https://veloratrade.ir/en/blog/" },
    },
  };
}

export default function BlogIndexPage() {
  const t = createTranslator("fa", ["common", "blog"]);
  return (
    <main className="legal-shell">
      <header className="legal-top">
        <a href="/" className="legal-brand">VELORA</a>
        <a href="/" className="legal-back">{t("common.back.to.home.cc9795cf", null, "بازگشت به خانه")}</a>
      </header>
      <section className="legal-hero">
        <p className="legal-eyebrow">{t("common.professional.trading.education.9ae5f789", null, "تحصیلات حرفه‌ای معامله‌گری")}</p>
        <h1>{t("common.blog.4a829cc7", null, "وبلاگ")}</h1>
        <p className="legal-lead">{t("common.education.for.trading.journals.performance.analytics.risk.75b21185", null, "")}</p>
      </section>
      <div className="blog-grid">
        {BLOG_POSTS.map((post) => (
          <Link key={post.slug} href={`/blog/${post.slug}`} className="card blog-card">
            <b>{t(post.titleKey)}</b>
            <p className="muted-xs mt-6">{t(post.keys[1] ?? post.titleKey)}</p>
            <small className="muted-xs">{t("common.8.min.read.81675063", null, "8 min read")}</small>
          </Link>
        ))}
      </div>
      <footer className="legal-footer">
        <p className="muted-xs">{t("common.2026.velora.all.rights.reserved.5d192dfd", null, "© 2026 VELORA")}</p>
      </footer>
    </main>
  );
}
