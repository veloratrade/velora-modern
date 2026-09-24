"use client";

import { useEffect } from "react";

/**
 * LandingRuntime — ports the behavioral core of Legacy's inline landing script
 * (`localized/en/index.html` <script> @edede31, 584 lines) into a single
 * client island. No hard-coded copy; all text stays server-rendered via catalogs.
 * Only DOM behavior and canvas are client-side.
 *
 * Behaviors covered (see /tmp/landing_script.js section map):
 *  - reveal / html.anim + forceReveal
 *  - scroll progress (#prog), header scrolled, scrollspy, to-top
 *  - cursor glow
 *  - count-up [data-count]
 *  - stagger .grid-stagger > .reveal
 *  - newsletter #nl-form
 *  - hero canvas #bg3d (stars/dust/rings/grid)
 *  - tilt (.tilt, .tilt-img, #vframe parallax)
 *  - mobile nav (#nav-toggle, #links, .nav-dd)
 *  - dashboard .db animations (gauges, bars, chart tabs)
 *  - reduced-motion respect
 */

export function LandingRuntime() {
  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- reveal / html.anim ----
    const forceReveal = () => {
      document.querySelectorAll<HTMLElement>(".reveal:not(.in)").forEach((el) => el.classList.add("in"));
    };
    let animReady = false;
    try {
      animReady = "IntersectionObserver" in window && !reduceMotion;
    } catch {
      animReady = false;
    }
    if (animReady) {
      document.documentElement.classList.add("anim");
      const vh = window.innerHeight || 800;
      document.querySelectorAll<HTMLElement>(".reveal").forEach((el) => {
        try {
          const r = el.getBoundingClientRect();
          if (r.top < vh * 0.95 && r.bottom > 0) el.classList.add("in");
        } catch {
          el.classList.add("in");
        }
      });
    } else {
      forceReveal();
    }
    const t1 = setTimeout(forceReveal, 1500);
    const onLoad = () => setTimeout(forceReveal, 800);
    window.addEventListener("load", onLoad);
    const onScrollReveal = () => {
      if (document.querySelectorAll(".reveal:not(.in)").length) requestAnimationFrame(forceReveal);
    };
    window.addEventListener("scroll", onScrollReveal, { passive: true });

    // Stagger
    document.querySelectorAll<HTMLElement>(".grid-stagger > .reveal").forEach((el, i) => {
      el.style.transitionDelay = `${(i % 3) * 90}ms`;
    });
    try {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              (en.target as HTMLElement).classList.add("in");
              io.unobserve(en.target);
            }
          });
        },
        { threshold: 0.12 },
      );
      document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    } catch {
      forceReveal();
    }

    // ---- scroll progress + header + toTop + scrollspy ----
    const prog = document.getElementById("prog");
    const header = document.getElementById("header");
    const toTop = document.getElementById("toTop");
    const spyLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('nav.links a[href^="#"]'));
    const spyMap = new Map<string, HTMLAnchorElement>();
    spyLinks.forEach((a) => spyMap.set(a.getAttribute("href")!.slice(1), a));
    const spySecs = Array.from(document.querySelectorAll<HTMLElement>("section[id]")).filter((s) => spyMap.has(s.id));
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      if (prog) prog.style.width = `${max > 0 ? (h.scrollTop / max) * 100 : 0}%`;
      header?.classList.toggle("scrolled", h.scrollTop > 40);
      toTop?.classList.toggle("show", h.scrollTop > 640);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    let spyIO: IntersectionObserver | null = null;
    if (spySecs.length && "IntersectionObserver" in window) {
      spyIO = new IntersectionObserver(
        (es) => {
          es.forEach((en) => {
            if (en.isIntersecting) {
              spyLinks.forEach((a) => a.classList.remove("active"));
              const a = spyMap.get((en.target as HTMLElement).id);
              a?.classList.add("active");
            }
          });
        },
        { rootMargin: "-40% 0px -55% 0px" },
      );
      spySecs.forEach((s) => spyIO!.observe(s));
    }
    toTop?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

    // ---- cursor glow ----
    if (window.matchMedia("(pointer:fine)").matches && !reduceMotion) {
      const g = document.getElementById("cursorGlow");
      if (g) {
        document.body.classList.add("cg");
        let tx = 0,
          ty = 0,
          cx = -400,
          cy = -400,
          raf: number | null = null;
        const loop = () => {
          cx += (tx - cx) * 0.13;
          cy += (ty - cy) * 0.13;
          g.style.transform = `translate(${cx - 170}px,${cy - 170}px)`;
          raf = null;
          if (Math.abs(tx - cx) > 0.6 || Math.abs(ty - cy) > 0.6) raf = requestAnimationFrame(loop);
        };
        window.addEventListener(
          "mousemove",
          (e) => {
            tx = e.clientX;
            ty = e.clientY;
            if (!raf) raf = requestAnimationFrame(loop);
          },
          { passive: true },
        );
      }
    }

    // ---- count-up [data-count] ----
    // Use Intl.NumberFormat with numberingSystem latn (same as fmtNumber) but avoid importing server code.
    const fmt = (n: number, unit?: string) => {
      const locale = document.documentElement.lang.startsWith("fa") ? "fa-IR" : "en-GB";
      if (unit) {
        try {
          return new Intl.NumberFormat(locale, {
            style: "unit",
            unit: unit as Intl.NumberFormatOptions["unit"],
            unitDisplay: "short",
            maximumFractionDigits: 0,
            numberingSystem: "latn",
          } as Intl.NumberFormatOptions).format(n);
        } catch {
          return String(n);
        }
      }
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, numberingSystem: "latn" } as Intl.NumberFormatOptions).format(n);
    };
    document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
      const target = parseFloat(el.dataset.count ?? "0");
      const unit = el.dataset.unit ?? "";
      if (!("IntersectionObserver" in window)) {
        el.textContent = unit ? fmt(Math.round(target), unit) : fmt(Math.round(target));
        return;
      }
      const io2 = new IntersectionObserver(
        (entries) => {
          if (!entries[0]?.isIntersecting) return;
          io2.disconnect();
          const D = 1400;
          const t0 = performance.now();
          const step = (now: number) => {
            const k = Math.min((now - t0) / D, 1);
            const e = 1 - Math.pow(1 - k, 3);
            el.textContent = unit ? fmt(Math.round(target * e), unit) : fmt(Math.round(target * e));
            if (k < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        },
        { threshold: 0.5 },
      );
      io2.observe(el);
    });

    // ---- newsletter ----
    const nf = document.getElementById("nl-form") as HTMLFormElement | null;
    const ok = document.getElementById("nl-ok");
    if (nf && ok) {
      nf.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = (document.getElementById("nl-email") as HTMLInputElement | null)?.value.trim() ?? "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          (document.getElementById("nl-email") as HTMLInputElement | null)?.focus();
          return;
        }
        // CAPABILITY GAP: no backend for newsletter — Legacy was also fake (hid form, showed ok).
        // Do not invent a POST; keep the same fake success UI.
        nf.hidden = true;
        ok.hidden = false;
        try {
          (window as unknown as { VeloraSound?: { play: (k: string) => void } }).VeloraSound?.play("success");
        } catch {}
      });
    }

    // ---- hero background canvas #bg3d ----
    (() => {
      const c = document.getElementById("bg3d") as HTMLCanvasElement | null;
      if (!c || reduceMotion) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const DPR = Math.min(window.devicePixelRatio || 1, 2);
      const fit = () => {
        const r = c.getBoundingClientRect();
        c.width = r.width * DPR;
        c.height = r.height * DPR;
      };
      fit();
      let W = c.width,
        H = c.height;
      window.addEventListener("resize", () => {
        fit();
        W = c.width;
        H = c.height;
      });
      const TAU = Math.PI * 2;
      const R = (x: number, y: number, z: number) => ({ x, y, z });
      const rotX = (p: { x: number; y: number; z: number }, a: number) => {
        const co = Math.cos(a),
          s = Math.sin(a);
        return { x: p.x, y: p.y * co - p.z * s, z: p.y * s + p.z * co };
      };
      const rotY = (p: { x: number; y: number; z: number }, a: number) => {
        const co = Math.cos(a),
          s = Math.sin(a);
        return { x: p.x * co + p.z * s, y: p.y, z: -p.x * s + p.z * co };
      };
      const project = (p: { x: number; y: number; z: number }, f: number, w: number, h: number) => {
        const s = f / (f + p.z);
        return { x: w / 2 + p.x * s, y: h / 2 + p.y * s, s };
      };
      const ringPts = (n: number, r: number, ty: number) => {
        const pts: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU;
          let p = R(Math.cos(a) * r, 0, Math.sin(a) * r);
          p = rotX(p, ty);
          pts.push(p);
        }
        return pts;
      };
      const stars = Array.from({ length: 220 }, () => ({
        x: Math.random(),
        y: Math.random(),
        z: Math.random(),
        s: 0.4 + Math.random() * 1.6,
        tw: Math.random() * TAU,
      }));
      const dust = Array.from({ length: 50 }, () => ({
        x: Math.random(),
        y: Math.random(),
        r: 0.6 + Math.random() * 1.6,
        sp: 0.00025 + Math.random() * 0.0006,
        ph: Math.random() * TAU,
      }));
      const rings = [ringPts(90, Math.min(W, H) * 0.42, 0.5), ringPts(70, Math.min(W, H) * 0.56, 1.1)];
      let t = 0;
      let vis = true;
      try {
        new IntersectionObserver((e) => {
          vis = e[0]?.isIntersecting ?? true;
        }).observe(c);
      } catch {}
      const frame = () => {
        if (vis) {
          t += 0.008;
          ctx.clearRect(0, 0, W, H);
          for (const st of stars) {
            const x = st.x * W,
              y = ((st.y * H - (t * 8 * st.z) % H) + H) % H;
            st.tw += 0.04;
            const a = 0.15 + Math.abs(Math.sin(st.tw)) * 0.5;
            ctx.fillStyle = `rgba(240,214,124,${(a * (1 - st.z * 0.6)).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, st.s * (1 - st.z * 0.5), 0, TAU);
            ctx.fill();
          }
          for (const d of dust) {
            d.y -= d.sp;
            if (d.y < -0.02) d.y = 1.02;
            const a = 0.1 + Math.abs(Math.sin(t * 2 + d.ph)) * 0.35;
            ctx.fillStyle = `rgba(233,196,92,${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(d.x * W, d.y * H, d.r, 0, TAU);
            ctx.fill();
          }
          for (let ri = 0; ri < rings.length; ri++) {
            const ring = rings[ri]!;
            const dir = ri % 2 ? 1 : -1;
            ctx.beginPath();
            for (let i = 0; i < ring.length; i++) {
              let p = rotY(ring[i]!, t * dir * (0.3 + ri * 0.15) + ri * 2);
              p = rotX(p, 0.35 + ri * 0.25);
              const pr = project(p, Math.min(W, H) * 1.6, W, H);
              if (i === 0) ctx.moveTo(pr.x, pr.y);
              else ctx.lineTo(pr.x, pr.y);
            }
            ctx.closePath();
            ctx.strokeStyle = `rgba(212,175,55,${(0.1 + 0.05 * ri).toFixed(2)})`;
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
          const f = Math.min(W, H) * 2.2;
          ctx.strokeStyle = "rgba(212,175,55,.07)";
          ctx.lineWidth = 1;
          for (let i = -9; i <= 9; i++) {
            const a = i / 9;
            const p1 = project(R(a * Math.min(W, H) * 0.9, 0, -Math.min(W, H) * 0.8), f, W, H);
            const p2 = project(R(a * Math.min(W, H) * 0.9, 0, Math.min(W, H) * 1.2), f, W, H);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
          for (let i = 0; i <= 10; i++) {
            const a = i / 10;
            const p1 = project(R(-Math.min(W, H) * 0.9, 0, -Math.min(W, H) * 0.8 + a * Math.min(W, H) * 2), f, W, H);
            const p2 = project(R(Math.min(W, H) * 0.9, 0, -Math.min(W, H) * 0.8 + a * Math.min(W, H) * 2), f, W, H);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }
        requestAnimationFrame(frame);
      };
      frame();
    })();

    // ---- tilt (.tilt, .tilt-img, #vframe) ----
    if (!reduceMotion) {
      document.querySelectorAll<HTMLElement>(".tilt").forEach((card) => {
        card.addEventListener("mousemove", (e) => {
          const r = card.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width - 0.5;
          const y = (e.clientY - r.top) / r.height - 0.5;
          card.style.transform = `translateY(-6px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg)`;
        });
        card.addEventListener("mouseleave", () => {
          card.style.transform = "";
        });
      });
      document.querySelectorAll<HTMLElement>(".tilt-img").forEach((img) => {
        img.addEventListener("mousemove", (e) => {
          const r = img.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width - 0.5;
          const y = (e.clientY - r.top) / r.height - 0.5;
          img.style.transform = `rotateY(${x * 8}deg) rotateX(${-y * 8}deg)`;
        });
        img.addEventListener("mouseleave", () => {
          img.style.transform = "";
        });
      });
      const vf = document.getElementById("vframe");
      const hero = document.querySelector<HTMLElement>(".hero");
      if (vf && hero) {
        hero.addEventListener("mousemove", (e) => {
          const r = hero.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width - 0.5;
          const y = (e.clientY - r.top) / r.height - 0.5;
          vf.style.transform = `rotateY(${x * 7}deg) rotateX(${-y * 7}deg)`;
        });
        hero.addEventListener("mouseleave", () => {
          vf.style.transform = "";
        });
      }
    }

    // ---- mobile nav ----
    const nt = document.getElementById("nav-toggle");
    const links = document.getElementById("links");
    if (nt && links) {
      nt.addEventListener("click", () => links.classList.toggle("open"));
      links.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => links.classList.remove("open")));
      const navDD = document.querySelector<HTMLElement>(".nav-dd");
      if (navDD) {
        const btn = navDD.querySelector<HTMLButtonElement>(".nav-dd-btn");
        if (btn) {
          const setOpen = (v: boolean) => {
            navDD.classList.toggle("open", v);
            btn.setAttribute("aria-expanded", v ? "true" : "false");
          };
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            setOpen(!navDD.classList.contains("open"));
          });
          document.addEventListener("click", (e) => {
            if (!navDD.contains(e.target as Node)) setOpen(false);
          });
          navDD.addEventListener("mouseleave", () => setOpen(false));
        }
      }
    }

    // ---- dashboard .db animations ----
    const CIRC = 163.4;
    if ("IntersectionObserver" in window) {
      const dashIO = new IntersectionObserver(
        (es) => {
          es.forEach((en) => {
            if (!en.isIntersecting) return;
            const root = en.target as HTMLElement;
            root.querySelectorAll<HTMLElement>(".k-gauge .fill").forEach((f) => {
              const pct = parseFloat(f.dataset.pct ?? "0");
              (f as unknown as { style: CSSStyleDeclaration }).style.strokeDashoffset = `${(CIRC * (1 - pct / 100)).toFixed(1)}`;
            });
            root.querySelectorAll<HTMLElement>(".k-bar i").forEach((b) => {
              (b as HTMLElement).style.width = `${b.dataset.w ?? 0}%`;
            });
            root.querySelectorAll<HTMLElement>(".psy-track i").forEach((b) => {
              (b as HTMLElement).style.width = `${b.dataset.w ?? 0}%`;
            });
            root.querySelectorAll<HTMLElement>(".cons-bars .cb i").forEach((b) => {
              (b as HTMLElement).style.height = `${b.dataset.h ?? 0}%`;
            });
            if (!root.dataset.charted) {
              root.dataset.charted = "1";
              const p = root.querySelector<HTMLElement>(".eq-path");
              if (p) setTimeout(() => (p.style.strokeDashoffset = "0"), 180);
            }
            dashIO.unobserve(root);
          });
        },
        { threshold: 0.22 },
      );
      document.querySelectorAll(".db").forEach((el) => dashIO.observe(el));

      document.querySelectorAll<HTMLElement>("[data-chart]").forEach((group) => {
        const paths = group.querySelectorAll<HTMLElement>(".eq-path, .eq-area");
        group.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((btn) => {
          btn.addEventListener("click", () => {
            group.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("on"));
            btn.classList.add("on");
            const k = btn.dataset.tab as "day" | "week" | "month" | undefined;
            if (!k) return;
            paths.forEach((p) => {
              if (p.classList.contains("eq-path")) (p as HTMLElement).style.strokeDashoffset = "1400";
              setTimeout(() => {
                const d = (p as HTMLElement).dataset[`d${k}` as "dday" | "dweek" | "dmonth"];
                if (d) p.setAttribute("d", d);
                if (p.classList.contains("eq-path")) (p as HTMLElement).style.strokeDashoffset = "0";
              }, 90);
            });
          });
        });
      });
    } else {
      // No IO: show all gauges immediately.
      document.querySelectorAll<HTMLElement>(".k-gauge .fill").forEach((f) => {
        const pct = parseFloat(f.dataset.pct ?? "0");
        (f as unknown as { style: CSSStyleDeclaration }).style.strokeDashoffset = `${(CIRC * (1 - pct / 100)).toFixed(1)}`;
      });
      document.querySelectorAll<HTMLElement>(".k-bar i").forEach((b) => {
        (b as HTMLElement).style.width = `${b.dataset.w ?? 0}%`;
      });
      document.querySelectorAll<HTMLElement>(".psy-track i").forEach((b) => {
        (b as HTMLElement).style.width = `${b.dataset.w ?? 0}%`;
      });
      document.querySelectorAll<HTMLElement>(".cons-bars .cb i").forEach((b) => {
        (b as HTMLElement).style.height = `${b.dataset.h ?? 0}%`;
      });
    }

    return () => {
      clearTimeout(t1);
      window.removeEventListener("load", onLoad);
      window.removeEventListener("scroll", onScrollReveal);
      window.removeEventListener("scroll", onScroll);
      spyIO?.disconnect();
    };
  }, []);

  return null;
}
