// The navigable menu — pure builders, so every screen is a function of data a test can state.
//
// WHY THIS IS NOT INSIDE `telegramBot.ts`. The bot is already 2.6k lines of routing and behaviour; a
// menu that renders its own data-window logic would double it and make each screen impossible to
// assert alone. Everything here returns `{ text, keyboard }` and touches nothing: no Bot API, no
// database, no clock. `telegramBot.ts` supplies the values and owns the side effects.
//
// WHAT "NO FAKE BUTTON" MEANS HERE. Every `callbackData` below parses against the closed vocabulary in
// `@velora/contracts` (`CALLBACK_ACTIONS` + `MENU_TARGETS`), and `telegramMenus.test.ts` walks every
// screen and asserts exactly that. A button whose action has no handler is therefore a failing test
// rather than a dead tap in production.
//
// ABSENT CAPABILITIES ARE STATED, NEVER HIDDEN. A deployment without the post service still renders
// the Posts section (so the user is not left wondering where it went) and says in one sentence that
// it is unavailable here. The same rule covers PNG rendering: it is reported as unavailable, not
// silently dropped and not faked.
import { buildCallbackData, MENU_TARGETS } from "@velora/contracts";
import type { InlineKeyboardButton } from "./telegramApi.js";
import type { TelegramCopy } from "./telegramCopy.js";
import type { TelegramPostPreferences, TelegramTemplateRecord } from "./telegramStore.js";

/** What a screen is: the text plus the keyboard that got the user there. */
export interface MenuScreen {
  readonly text: string;
  readonly keyboard: readonly (readonly InlineKeyboardButton[])[];
}

/** How many templates fit on one page. Four keeps the message under one screen on a phone. */
export const TEMPLATES_PER_PAGE = 4;

const nav = (text: string, target: (typeof MENU_TARGETS)[number]): InlineKeyboardButton => ({
  text,
  callbackData: buildCallbackData("menu", target),
});

/** The two ways out of every screen, so no screen is a dead end. */
const backAndHome = (copy: TelegramCopy, back: (typeof MENU_TARGETS)[number]): InlineKeyboardButton[] => [
  nav(copy.btnBack, back),
  nav(copy.btnHome, "home"),
];

// ── Screens ────────────────────────────────────────────────────────────────

/**
 * The main menu: the six sections the user asked for.
 *
 * `posts` is rendered even when the service is absent — see the file header; the SECTION explains the
 * absence instead of the button disappearing, because "the button is gone" reads as a bug.
 */
export function mainMenu(copy: TelegramCopy, options: { readonly postsWired: boolean }): MenuScreen {
  // The posts button is labelled with the CAPABILITY only where the capability exists: a deployment
  // without the post service still gets the section (so the user finds out why, instead of finding a
  // hole), but it is named as the section, not as the action it cannot perform. That is the same rule
  // the old flat menu followed, kept.
  const postsLabel = options.postsWired ? copy.btnPost : copy.navPostsTitle.replace(/<[^>]+>/gu, "").trim();
  return {
    text: `${copy.navTitle}\n\n${copy.navHome}`,
    keyboard: [
      [nav(copy.btnNewJournal, "journal"), nav(postsLabel, "posts")],
      [nav(copy.navTplTitle.replace(/<[^>]+>/gu, "").trim(), "templates")],
      [nav(bannerLabel(copy), "banner"), nav(aiLabel(copy), "ai")],
      [nav(copy.btnSettings, "settings"), nav(copy.navHelpTitle.replace(/<[^>]+>/gu, "").trim(), "help")],
    ],
  };
}

/** The section labels, stripped of the markup they carry in the `<b>` titles. */
const bannerLabel = (copy: TelegramCopy): string => "🖼 بنر و ظاهر / Banner";
const aiLabel = (copy: TelegramCopy): string => "🤖 ابزارهای هوش مصنوعی / AI";

/** The journal section: the four things a journal does, plus its two reminders. */
export function journalMenu(copy: TelegramCopy): MenuScreen {
  return {
    text: `${copy.navJournalTitle}\n\n${copy.navJournalBody}`,
    keyboard: [
      [nav(copy.btnNewJournal, "journal"), nav(copy.btnLastTrade, "last")],
      [nav(copy.btnHistory, "history"), nav(copy.btnStats, "stats")],
      [nav(copy.btnChecklist, "checklist"), nav(copy.btnAnalyze, "analyze")],
      backAndHome(copy, "home"),
    ],
  };
}

/**
 * Posts and publishing.
 *
 * Every button here does work that already existed as a command (`/post`, `/template`, the publish
 * button); this screen is navigation over it, not a second implementation.
 */
export function postsMenu(copy: TelegramCopy, options: { readonly postsWired: boolean; readonly defaultTemplateName: string | null }): MenuScreen {
  if (!options.postsWired) {
    return {
      text: `${copy.navPostsTitle}\n\n${copy.navPostsUnavailable}`,
      keyboard: [backAndHome(copy, "home")],
    };
  }
  const defaultLine =
    options.defaultTemplateName === null
      ? copy.tplDefaultCleared
      : copy.tplDefaultSet(options.defaultTemplateName);
  return {
    text: `${copy.navPostsTitle}\n\n${copy.navPostsBody}\n\n${defaultLine}`,
    keyboard: [
      // "New post" IS `/post` — same handler, so the button cannot bypass the preview or the approval.
      [{ text: copy.btnPostNew, callbackData: buildCallbackData("menu", "post") }],
      [nav(copy.btnPostTplList, "templates"), nav(copy.btnPostPreview, "post")],
      // The outcome screen: what actually left the account, and why nothing did when nothing did.
      [nav(copy.btnPostResult, "postresult")],
      backAndHome(copy, "home"),
    ],
  };
}

/**
 * The template list, paginated.
 *
 * Why an id and not the name in the payload: Telegram's callback data is ASCII-only, and a Persian
 * template name cannot travel in it. The id is stable, and the handler re-reads the row by id anyway
 * (`findTemplateById`), so nothing is trusted from the button.
 */
export function templatesMenu(
  copy: TelegramCopy,
  options: {
    readonly templates: readonly TelegramTemplateRecord[];
    readonly preferences: TelegramPostPreferences;
    readonly page: number;
    readonly postsWired: boolean;
  },
): MenuScreen {
  if (!options.postsWired) {
    return {
      text: `${copy.navTplTitle}\n\n${copy.navPostsUnavailable}`,
      keyboard: [backAndHome(copy, "posts")],
    };
  }
  const pages = Math.max(1, Math.ceil(options.templates.length / TEMPLATES_PER_PAGE));
  const page = Math.min(Math.max(1, options.page), pages);
  const slice = options.templates.slice((page - 1) * TEMPLATES_PER_PAGE, page * TEMPLATES_PER_PAGE);

  const rows: InlineKeyboardButton[][] = [];
  if (options.templates.length === 0) {
    rows.push([{ text: copy.btnTplNew, callbackData: buildCallbackData("tpl_new", "none") }]);
    rows.push([...backAndHome(copy, "posts")]);
    return { text: `${copy.navTplTitle}\n\n${copy.tplEmpty}`, keyboard: rows };
  }

  for (const template of slice) {
    const star = options.preferences.defaultTemplateName === template.name ? `${copy.tplDefaultMark} ` : "";
    rows.push([{ text: `${star}${template.name}`, callbackData: buildCallbackData("tpl_pv", template.id) }]);
    rows.push([
      { text: copy.btnTplEdit, callbackData: buildCallbackData("tpl_edit", template.id) },
      { text: copy.btnTplDelete, callbackData: buildCallbackData("tpl_del", template.id) },
      { text: copy.btnTplDefault, callbackData: buildCallbackData("tpl_def", template.id) },
    ]);
  }
  rows.push([{ text: copy.btnTplNew, callbackData: buildCallbackData("tpl_new", "none") }]);
  if (pages > 1) {
    // Pagination is arithmetic over a list this function was given — never a stored cursor.
    const pager: InlineKeyboardButton[] = [];
    if (page > 1) pager.push({ text: `◀️ ${String(page - 1)}/${String(pages)}`, callbackData: buildCallbackData("tpl_list", String(page - 1)) });
    if (page < pages) pager.push({ text: `${String(page + 1)}/${String(pages)} ▶️`, callbackData: buildCallbackData("tpl_list", String(page + 1)) });
    if (pager.length > 0) rows.push(pager);
  }
  rows.push(backAndHome(copy, "posts"));
  return {
    text: `${copy.navTplTitle}\n\n${copy.navTplBody}\n\n${String(options.templates.length)} — صفحهٔ ${String(page)}/${String(pages)}`,
    keyboard: rows,
  };
}

/**
 * The publish-result screen: what left this account, and why nothing did when nothing did.
 *
 * This is the answer to "show the publishing result or a clear reason publication is unavailable", and
 * it reads the SAME rows the publish path writes — no second bookkeeping. A failed post keeps its
 * `errorCode` (0037's `failed_has_code`), so the screen can name the failure instead of saying
 * "something went wrong": that code is the difference between a channel permission problem and a
 * Telegram rate limit, and a user cannot act on the second if they are told the first.
 */
export function postResultMenu(
  copy: TelegramCopy,
  options: {
    readonly posts: readonly {
      readonly id: string;
      readonly status: string;
      readonly createdAt: string;
      readonly body: string;
      readonly telegramMessageId: string | null;
      readonly errorCode: string | null;
    }[];
    readonly blockedReason: string | null;
  },
): MenuScreen {
  const statusLabel = (status: string): string => {
    switch (status) {
      case "DRAFT": return copy.postStatusDraft;
      case "APPROVED": return copy.postStatusApproved;
      case "PUBLISHING": return copy.postStatusPublishing;
      case "PUBLISHED": return copy.postStatusPublished;
      case "FAILED": return copy.postStatusFailed;
      case "CANCELLED": return copy.postStatusCancelled;
      default: return status;
    }
  };
  const lines = options.posts.map((post) =>
    copy.postResultLine({
      when: post.createdAt.slice(0, 16).replace("T", " "),
      status: statusLabel(post.status),
      // One line of the post, escaped: enough to recognise WHICH post, never the whole card again.
      excerpt: post.body.replace(/\s+/gu, " ").trim().slice(0, 70),
      messageId: post.telegramMessageId,
      errorCode: post.errorCode,
    }),
  );
  const text = [
    copy.postResultTitle,
    "",
    ...(lines.length === 0 ? [copy.postResultEmpty] : lines),
    ...(options.blockedReason === null ? [] : ["", copy.postResultUnavailable(options.blockedReason)]),
  ].join("\n");
  return {
    text,
    keyboard: [
      [{ text: copy.btnPostNew, callbackData: buildCallbackData("menu", "post") }],
      backAndHome(copy, "posts"),
    ],
  };
}

/**
 * Banner and appearance.
 *
 * `canRaster` is the runtime's own answer, not a guess: when it is false the screen says the text card
 * is what will be sent. The style list is deliberately a list of ONE, because `renderBanner` composes
 * exactly one palette (`BANNER_PALETTE`); offering a "theme" picker over an unimplemented renderer
 * would be the fake setting this task forbids.
 */
export function bannerMenu(
  copy: TelegramCopy,
  options: { readonly preferences: TelegramPostPreferences; readonly canRaster: boolean },
): MenuScreen {
  const prefs = options.preferences;
  const rows: InlineKeyboardButton[][] = [
    [{ text: copy.btnBnToggle, callbackData: buildCallbackData("bn_toggle", prefs.bannerEnabled ? "off" : "on") }],
    [{ text: copy.btnBnTitle, callbackData: buildCallbackData("bn_title", "ask") }],
  ];
  if (prefs.bannerTitle !== null) {
    rows.push([{ text: copy.btnBnClearTitle, callbackData: buildCallbackData("bn_title", "clear") }]);
  }
  rows.push(backAndHome(copy, "home"));
  return {
    text: `${copy.navBannerTitle}\n\n${copy.navBannerBody({
      enabled: prefs.bannerEnabled,
      title: prefs.bannerTitle,
      canRaster: options.canRaster,
    })}`,
    keyboard: rows,
  };
}

/** One line per tool: wired or not, and the exact missing key NAMES when it is not. */
export function aiMenu(
  copy: TelegramCopy,
  options: {
    readonly tools: readonly { readonly name: string; readonly state: string; readonly missing: readonly string[]; readonly reason: string | null }[];
  },
): MenuScreen {
  const lines = options.tools.map((tool) => {
    const verdict = tool.state === "configured" ? copy.aiOn : copy.aiOff;
    const why = tool.missing.length > 0 ? ` — ${copy.aiMissing(tool.missing)}` : tool.reason === null ? "" : ` — ${tool.reason}`;
    return `• <b>${tool.name}</b>: ${verdict}${why}`;
  });
  return {
    text: [copy.navAiTitle, "", ...lines, "", copy.aiNoSecretNote, copy.aiConsentNote].join("\n"),
    keyboard: [backAndHome(copy, "home")],
  };
}

/** Help: the buttons are the primary path, the commands are the compatibility layer. */
export function helpMenu(copy: TelegramCopy, body: string): MenuScreen {
  return {
    text: `${copy.navHelpTitle}\n\n${copy.navHelpBody}\n\n${body}`,
    keyboard: [backAndHome(copy, "home")],
  };
}

/**
 * The guided flow's own "cancel" row, so an open prompt is never a trap.
 *
 * `flow_cancel` clears the persisted cursor — it is NOT `menu:templates`, because navigating away
 * while a prompt is open would leave the cursor armed and the user's next sentence captured by a
 * question they had already abandoned.
 */
export function flowKeyboard(copy: TelegramCopy): readonly (readonly InlineKeyboardButton[])[] {
  return [[{ text: copy.btnCancelFlow, callbackData: buildCallbackData("flow_cancel", "none") }]];
}
