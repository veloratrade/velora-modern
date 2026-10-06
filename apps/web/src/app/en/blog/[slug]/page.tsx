import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createTranslator } from "../../../../i18n/catalog";
import { BLOG_POSTS } from "../../../blog/posts";

/** /en/blog/<slug> — the English mirror of an article (ADR-009). */
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return BLOG_POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) return {};
  const t = createTranslator("en", ["common", "blog"]);
  return {
    title: `${t(post.titleKey)} | VELORA`,
    alternates: {
      canonical: `https://veloratrade.ir/en/blog/${slug}`,
      languages: { fa: `https://veloratrade.ir/blog/${slug}`, en: `https://veloratrade.ir/en/blog/${slug}`, "x-default": `https://veloratrade.ir/en/blog/${slug}` },
    },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) notFound();
  const t = createTranslator("en", ["common", "blog"]);
  return (
    <main className="legal-shell">
      <header className="legal-top">
        <a href="/en/" className="legal-brand">VELORA</a>
        <a href="/en/blog/" className="legal-back">{t("common.all.articles.5a07294c", null, "All articles")}</a>
      </header>
      <article className="legal-doc">
        <h1>{t(post.titleKey)}</h1>
        {post.keys.map((key) => (
          <p key={key}>{t(key)}</p>
        ))}
      </article>
      <footer className="legal-footer">
        <p className="muted-xs">{t("common.2026.velora.all.rights.reserved.5d192dfd", null, "© 2026 VELORA")}</p>
      </footer>
    </main>
  );
}
