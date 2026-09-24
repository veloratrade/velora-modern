"use client";

import { useEffect, useState } from "react";

/**
 * Product story gallery — behavior of Legacy velora-product-gallery.js.
 * Enhances the server-rendered #screenshots .shots grid after hydration:
 *  - adds story-gallery class, tab bar, overlays (LIVE BEHAVIOUR...), insights, CTA.
 *  - tab switching with story-active/story-enter animations.
 * No hard-coded copy: all strings come from the landing-interactive catalog.
 */

interface GalleryCopy {
  tabs: readonly string[]; // 4
  overlays: readonly string[]; // 4
  insights: readonly string[]; // 4  (the d[3] per tab)
  outcomeLabel: string; // "KEY OUTCOME" / "نتیجهٔ کلیدی"
  cta: string;
}

export function ProductGallery({ copy }: { copy: GalleryCopy }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const section = document.getElementById("screenshots");
    if (!section) return;
    const grid = section.querySelector<HTMLElement>(".shots");
    if (!grid) return;
    const items = Array.from(grid.querySelectorAll<HTMLElement>(".shot"));
    if (items.length < 2) return;

    grid.classList.add("story-gallery");

    // Add overlays + insights once (idempotent).
    items.forEach((item, i) => {
      if (!item.querySelector(".story-overlay")) {
        const img = item.querySelector<HTMLElement>(".shot-img");
        if (img) {
          const ov = document.createElement("div");
          ov.className = "story-overlay";
          ov.textContent = copy.overlays[i] ?? "";
          img.appendChild(ov);
        }
      }
      if (!item.querySelector(".story-insight")) {
        const cap = item.querySelector<HTMLElement>("figcaption");
        if (cap) {
          const ins = document.createElement("div");
          ins.className = "story-insight";
          ins.innerHTML = `<small>${copy.outcomeLabel}</small>${copy.insights[i] ?? ""}`;
          cap.appendChild(ins);
        }
      }
    });

    // CTA once.
    if (!section.querySelector(".story-cta")) {
      const cta = document.createElement("div");
      cta.className = "story-cta";
      cta.innerHTML = `<a href="/register"><span>${copy.cta}</span><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-6-6m6 6-6 6"/></svg></a>`;
      grid.parentNode?.insertBefore(cta, grid.nextSibling);
    }

    // Tabs container (we render tabs via React below, but also need to ensure
    // the DOM tabs exist for CSS that expects .product-story-tabs before grid).
    // React will render its own tabs; we hide the DOM ones if duplicated.
    // Instead, we let React own the tabs and just mark items.
  }, [copy]);

  useEffect(() => {
    const grid = document.getElementById("screenshots")?.querySelector<HTMLElement>(".shots");
    if (!grid) return;
    const items = Array.from(grid.querySelectorAll<HTMLElement>(".shot"));
    items.forEach((item, i) => {
      item.classList.toggle("story-active", i === active);
      // Trigger enter animation.
      if (i === active) {
        item.classList.remove("story-enter");
        void item.offsetWidth;
        item.classList.add("story-enter");
      } else {
        item.classList.remove("story-enter");
      }
    });
    // Ensure story-gallery class stays.
    grid.classList.add("story-gallery");
  }, [active]);

  // Render the tab bar as React (sibling to the server grid, but CSS expects
  // .product-story-tabs immediately before .shots).
  // We use an effect to move it, or just render it and let CSS handle order.
  // Simpler: render tabs and let the effect insert them before grid; hide React duplicate if needed.
  // Instead, we portal the tabs before the grid via DOM manipulation on mount.
  useEffect(() => {
    const section = document.getElementById("screenshots");
    const grid = section?.querySelector<HTMLElement>(".shots");
    if (!grid || grid.previousElementSibling?.classList.contains("product-story-tabs")) return;
    // If React tabs not yet in correct place, move them.
    const reactTabs = document.getElementById("product-gallery-tabs-react");
    if (reactTabs && reactTabs.parentElement !== grid.parentElement) {
      grid.parentNode?.insertBefore(reactTabs, grid);
    } else if (reactTabs) {
      grid.parentNode?.insertBefore(reactTabs, grid);
    }
  }, [active]);

  return (
    <div id="product-gallery-tabs-react" className="product-story-tabs" role="tablist">
      {copy.tabs.map((label, i) => (
        <button
          key={label}
          type="button"
          role="tab"
          aria-selected={active === i}
          className={`product-story-tab${active === i ? " active" : ""}`}
          onClick={() => setActive(i)}
        >
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8" />
            <path d="M8 12h8" />
          </svg>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
