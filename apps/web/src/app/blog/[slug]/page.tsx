import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createTranslator } from "../../../i18n/catalog";
import { BLOG_POSTS } from "../posts";

/**
 * Blog article — AC-32. The content sequence is Legacy's own `data-i18n` order
 * (see posts.ts provenance); the strings are byte copies in the `blog`+`common`
 * catalogs. Class B (editorial).
 */
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return BLOG_POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) return {};
  const t = createTranslator("fa", ["common", "blog"]);
  return {
    title: `${t(post.titleKey)} | VELORA`,
    alternates: {
      canonical: `https://veloratrade.ir/blog/${slug}`,
      languages: { fa: `https://veloratrade.ir/blog/${slug}`, en: `https://veloratrade.ir/en/blog/${slug}`, "x-default": `https://veloratrade.ir/en/blog/${slug}` },
    },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) notFound();
  const t = createTranslator("fa", ["common", "blog"]);
  return (
    <main className="legal-shell">
      <header className="legal-top">
        <a href="/" className="legal-brand">VELORA</a>
        <a href="/blog/" className="legal-back">{t("common.all.articles.5a07294c", null, "همه مقالات")}</a>
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
