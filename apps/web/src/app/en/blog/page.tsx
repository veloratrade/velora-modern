import type { Metadata } from "next";
import Link from "next/link";
import { createTranslator } from "../../../i18n/catalog";
import { BLOG_POSTS } from "../../blog/posts";

/** /en/blog — the English mirror (ADR-009). */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator("en", ["common", "blog"]);
  return {
    title: t("pages.blog.velora.blog.trading.journal.and.risk.management.68b13dc3", null, "VELORA Blog | Trading Journal & Risk Management"),
    alternates: {
      canonical: "https://veloratrade.ir/en/blog/",
      languages: { fa: "https://veloratrade.ir/blog/", en: "https://veloratrade.ir/en/blog/", "x-default": "https://veloratrade.ir/en/blog/" },
    },
  };
}

export default function BlogIndexPage() {
  const t = createTranslator("en", ["common", "blog"]);
  return (
    <main className="legal-shell">
      <header className="legal-top">
        <a href="/en/" className="legal-brand">VELORA</a>
        <a href="/en/" className="legal-back">{t("common.back.to.home.cc9795cf", null, "Back home")}</a>
      </header>
      <section className="legal-hero">
        <p className="legal-eyebrow">{t("common.professional.trading.education.9ae5f789", null, "Professional trading education")}</p>
        <h1>{t("common.blog.4a829cc7", null, "Blog")}</h1>
        <p className="legal-lead">{t("common.education.for.trading.journals.performance.analytics.risk.75b21185", null, "")}</p>
      </section>
      <div className="blog-grid">
        {BLOG_POSTS.map((post) => (
          <Link key={post.slug} href={`/en/blog/${post.slug}`} className="card blog-card">
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
