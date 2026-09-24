"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface HowCopy {
  close: string;
  connect: {
    kicker: string;
    title: string;
    intro: string;
    cards: readonly (readonly [string, string])[];
    line: string;
    primary: { label: string; href: string };
    secondary: { label: string; href: string };
  };
  sync: {
    kicker: string;
    title: string;
    intro: string;
    timeline: readonly string[];
    cards: readonly (readonly [string, string])[];
    primary: { label: string; href: string };
    secondary: { label: string; href: string };
  };
  grow: {
    kicker: string;
    title: string;
    intro: string;
    stats: readonly (readonly [string, string])[];
    insight: string;
    primary: { label: string; href: string };
    secondary: { label: string; href: string };
  };
}

type Kind = "connect" | "sync" | "grow";

function Icon({ kind }: { kind: Kind }) {
  const paths: Record<Kind, string> = {
    connect: `<rect x="5" y="4" width="14" height="16" rx="3"/><path d="M8.5 8h7M8.5 12h2m3 0h2M8.5 16h7"/><path d="M12 2v2m0 16v2"/>`,
    sync: `<path d="M20 7a8 8 0 0 0-14-2L4 7m0-3v3h3M4 17a8 8 0 0 0 14 2l2-2m0 3v-3h-3"/>`,
    grow: `<path d="M4 18 9 12l3 3 7-8"/><path d="M15 7h4v4"/>`,
  };
  return <svg viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: paths[kind] }} />;
}

/**
 * How-it-works modals — behavior of Legacy velora-how-modals.js,
 * but rendered as a React portal with catalog copy (no hard-coded literals).
 * Attaches to #how .step elements after mount (same as Legacy).
 */
export function HowModals({ copy }: { copy: HowCopy }) {
  const [open, setOpen] = useState<Kind | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const steps = document.querySelectorAll<HTMLDivElement>("#how .steps .step");
    if (steps.length < 3) return;
    const kinds: Kind[] = ["connect", "sync", "grow"];
    const handlers: Array<() => void> = [];
    kinds.forEach((kind, i) => {
      const step = steps[i];
      if (!step) return;
      step.tabIndex = 0;
      step.setAttribute("role", "button");
      step.setAttribute("aria-haspopup", "dialog");
      const h = () => setOpen(kind);
      const kh = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(kind);
        }
      };
      step.addEventListener("click", h);
      step.addEventListener("keydown", kh as unknown as EventListener);
      handlers.push(() => {
        step.removeEventListener("click", h);
        step.removeEventListener("keydown", kh as unknown as EventListener);
      });
    });
    return () => handlers.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    // Play sound if available (same as Legacy).
    try {
      (window as unknown as { VeloraSound?: { play: (k: string) => void } }).VeloraSound?.play("modal");
    } catch {}
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!mounted || !open) return null;

  const d =
    open === "connect"
      ? copy.connect
      : open === "sync"
        ? copy.sync
        : copy.grow;

  const isConnect = open === "connect";
  const isSync = open === "sync";
  const isGrow = open === "grow";

  const modal = (
    <div className="how-preview-backdrop" onClick={(e) => e.target === e.currentTarget && setOpen(null)}>
      <section className="how-preview" role="dialog" aria-modal="true">
        <button className="how-preview-close" aria-label={copy.close} onClick={() => setOpen(null)}>
          {copy.close}
        </button>
        <div className="how-preview-head">
          <div className="how-preview-icon">
            <Icon kind={open} />
          </div>
          <div>
            <div className="how-preview-kicker">{d.kicker}</div>
            <h2>{d.title}</h2>
          </div>
        </div>
        <p className="how-preview-intro">{d.intro}</p>
        {isConnect && (
          <>
            <div className="how-options">
              {(d as typeof copy.connect).cards.map(([title, body]) => (
                <div key={title} className="how-glass">
                  <b>{title}</b>
                  <p>{body}</p>
                </div>
              ))}
            </div>
            <div className="how-line">
              <Icon kind="connect" />
              <span>{(d as typeof copy.connect).line}</span>
            </div>
          </>
        )}
        {isSync && (
          <>
            <div className="how-timeline">
              {(d as typeof copy.sync).timeline.map((t) => (
                <div key={t}>{t}</div>
              ))}
            </div>
            <div className="how-options">
              {(d as typeof copy.sync).cards.map(([title, body]) => (
                <div key={title} className="how-glass">
                  <b>{title}</b>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          </>
        )}
        {isGrow && (
          <>
            <div className="how-stats">
              {(d as typeof copy.grow).stats.map(([label, value]) => (
                <div key={label} className="how-glass">
                  <b>{value}</b>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <div className="how-insight">{(d as typeof copy.grow).insight}</div>
          </>
        )}
        <div className="how-actions">
          <a className="how-action how-primary" href={d.primary.href}>
            {d.primary.label}
          </a>
          <a className="how-action how-secondary" href={d.secondary.href}>
            {d.secondary.label}
          </a>
        </div>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
