/*
 * Server-side i18n bridge for the landing page. Builds the helpers that the section
 * components use; nothing here ships to the browser except the strings passed as
 * props to client islands.
 *
 *   t(key)   catalog message as React nodes, digit runs isolated exactly like the
 *            Legacy velora-latin-digits.js walker did in the browser
 *   ta(key)  catalog message as a plain string (attributes: alt, aria-label, placeholder)
 *   d(text)  literal (non-translatable) text with the same digit isolation
 *   f(...)   Legacy [data-format] semantics (number/currency/percent/time), Latin digits
 *   href(p)  Legacy href -> Modern URL contract (ADR-009 PUBLIC_ROUTES / Stage 1 §H.4)
 */
import type { ReactNode } from "react";
import type { Locale } from "../../contracts";
import { createTranslator, type Translate } from "../../i18n/catalog";
import { formatValue, fmtNumber, fmtPercent, fmtTime, type FormatKind } from "../../i18n/format";
import { latinNodes } from "../../i18n/LatinText";
import { toLatin } from "../../i18n/latinDigits";
import { mapLegacyHref } from "./links";
import type { AiCopy } from "./AiChat";
import type { HowCopy } from "./HowModals";

export const LANDING_FEATURES = ["common", "errors", "landing", "landing-interactive"] as const;

export interface GalleryCopy {
  tabs: readonly string[];
  overlays: readonly string[];
  insights: readonly string[];
  outcomeLabel: string;
  cta: string;
}

export interface LandingI18n {
  readonly locale: Locale;
  t(key: string): ReactNode;
  ta(key: string): string;
  d(text: string): ReactNode;
  f(kind: FormatKind, value: string, options?: Intl.NumberFormatOptions, currency?: string): ReactNode;
  href(legacyPath: string): string;
  raw: Translate;
  aiCopy(): AiCopy;
  howCopy(): HowCopy;
  galleryCopy(): GalleryCopy;
}

export function createLandingI18n(locale: Locale): LandingI18n {
  const raw = createTranslator(locale, LANDING_FEATURES);
  const n = (v: number, o: Intl.NumberFormatOptions) => fmtNumber(locale, v, o);
  const p = (v: number, o: Intl.NumberFormatOptions) => fmtPercent(locale, v, o);
  return {
    locale,
    raw,
    t: (key) => latinNodes(raw(key)),
    ta: (key) => toLatin(raw(key)),
    d: (text) => latinNodes(text),
    f: (kind, value, options, currency) => latinNodes(formatValue(locale, kind, value, options ?? {}, currency ?? "USD")),
    href: (legacyPath) => mapLegacyHref(locale, legacyPath),
    aiCopy: () => {
      // Parameters identical to the Legacy landing script's answerParams(): these are
      // illustrative demo values of a SIMULATED coach (the page itself says so via
      // common.interactive.demo.responses.are.simulated...). No AI backend is called.
      const params = {
        confidence87: p(0.87, { maximumFractionDigits: 0 }),
        lossCount: n(3, { maximumFractionDigits: 0 }),
        sizeMultiplier: n(2, { maximumFractionDigits: 0 }),
        minutes: n(15, { maximumFractionDigits: 0 }),
        confidence94: p(0.94, { maximumFractionDigits: 0 }),
        pauseHours: n(2, { maximumFractionDigits: 0 }),
        reducedRisk: n(0.5, { maximumFractionDigits: 1 }),
        winRate68: p(0.68, { maximumFractionDigits: 0 }),
        averageR18: n(1.8, { maximumFractionDigits: 1 }),
        tradeCount: n(50, { maximumFractionDigits: 0 }),
        windowStart: fmtTime(locale, "09:00"),
        windowEnd: fmtTime(locale, "12:00"),
        outsideLossRate: p(0.71, { maximumFractionDigits: 0 }),
        setupRating: n(7.4, { maximumFractionDigits: 1 }),
        ratingMaximum: n(10, { maximumFractionDigits: 0 }),
        rewardRisk: n(2.6, { maximumFractionDigits: 1 }),
        setupWinRate: p(0.61, { maximumFractionDigits: 0 }),
        profitFactor: n(1.82, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        maxDrawdown: p(0.042, { maximumFractionDigits: 1 }),
        averageExitR: n(0.8, { maximumFractionDigits: 1 }),
        targetR: n(1.5, { maximumFractionDigits: 1 }),
      };
      const kinds = ["lose", "revenge", "edge", "setup"] as const;
      return {
        greeting: raw("common.hi.i.m.your.trading.co.pilot.7c04af05"),
        questions: {
          lose: raw("common.why.did.i.lose.this.trade.f2cb9c84"),
          revenge: raw("common.am.i.revenge.trading.bed94410"),
          edge: raw("common.what.is.my.edge.132e94a8"),
          setup: raw("common.should.i.take.this.setup.f0e6cd06"),
        },
        answers: {
          lose: raw("landing.ai.answer.lose", params),
          revenge: raw("landing.ai.answer.revenge", params),
          edge: raw("landing.ai.answer.edge", params),
          setup: raw("landing.ai.answer.setup", params),
          default: raw("landing.ai.answer.default", params),
        },
        intents: Object.fromEntries(
          kinds.map((k) => [
            k,
            raw(`landing.ai.intent.${k}`)
              .split(",")
              .map((w) => w.trim().toLowerCase())
              .filter(Boolean),
          ]),
        ) as AiCopy["intents"],
        prompts: [
          raw("landing.ai.prompt.free.ask"),
          raw("landing.ai.prompt.exit.early"),
          raw("landing.ai.prompt.best.session"),
          raw("landing.ai.prompt.reduce.drawdown"),
        ],
        insightPrompt: raw("landing.ai.prompt.insight.trades"),
        placeholder: raw("pages.landing.ask.about.your.trades.85a39707"),
        send: raw("pages.landing.send.261c4d69"),
        freeAsk: {
          prefix: raw("pages.landing.ai.free_question.prefix"),
          emphasis: raw("pages.landing.ai.free_question.emphasis"),
          suffix: raw("pages.landing.ai.free_question.suffix"),
          button: raw("pages.landing.ai.free_question.button"),
        },
      };
    },
    howCopy: () => {
      const k = (s: string) => raw(`landing.how.${s}`);
      const h = (s: string) => mapLegacyHref(locale, s);
      return {
        close: k("close"),
        connect: {
          kicker: k("connect.kicker"), title: k("connect.title"), intro: k("connect.intro"),
          cards: [1, 2, 3].map((i) => [k(`connect.card${i}.title`), k(`connect.card${i}.body`)] as const),
          line: k("connect.line"),
          primary: { label: k("connect.primary"), href: h("/accounts/connect/") },
          secondary: { label: k("connect.secondary"), href: h("/support/") },
        },
        sync: {
          kicker: k("sync.kicker"), title: k("sync.title"), intro: k("sync.intro"),
          timeline: [1, 2, 3, 4].map((i) => k(`sync.step${i}`)),
          cards: [1, 2].map((i) => [k(`sync.card${i}.title`), k(`sync.card${i}.body`)] as const),
          primary: { label: k("sync.primary"), href: h("/dashboard/") },
          secondary: { label: k("sync.secondary"), href: h("/privacy/") },
        },
        grow: {
          kicker: k("grow.kicker"), title: k("grow.title"), intro: k("grow.intro"),
          stats: [1, 2, 3, 4].map((i) => [k(`grow.stat${i}.label`), k(`grow.stat${i}.value`)] as const),
          insight: k("grow.insight"),
          primary: { label: k("grow.primary"), href: "#dashboard" },
          secondary: { label: k("grow.secondary"), href: h("/register/") },
        },
      };
    },
    galleryCopy: () => ({
      tabs: [1, 2, 3, 4].map((i) => raw(`landing.gallery.tab${i}`)),
      overlays: [1, 2, 3, 4].map((i) => raw(`landing.gallery.overlay${i}`)),
      insights: [1, 2, 3, 4].map((i) => raw(`landing.gallery.outcome${i}`)),
      outcomeLabel: raw("landing.gallery.outcome.label"),
      cta: raw("landing.gallery.cta"),
    }),
  };
}
