/**
 * The data port the prepared-post service reads through, bridged to the journal service that already
 * exists. It deliberately contains NO business rules: no date parsing, no metric computation, no
 * template logic. Every number a post shows is one the web app and `/stats` already show, from the
 * same functions, so a channel post can never disagree with the journal it came from.
 *
 * Why a bridge instead of the service querying the store directly: the journal service owns the user's
 * timezone, the sampled-window rule, the checklist merge semantics and the ownership checks. A second
 * path to the same tables would be a second set of those rules — and the divergence would show up as
 * a published post that contradicts the private journal.
 */
import type { JournalApplicationService } from "../journal/journalApplicationService.js";
import type { PostDataPort, PostStats, PostTrade } from "./telegramPostService.js";

export interface PostPortDeps {
  readonly journal: JournalApplicationService;
}

/** Read one stored trade field the way `asStatTrade` does: text when present, never a guess. */
function text(record: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function createPostDataPort(deps: PostPortDeps): PostDataPort {
  return {
    async checklistFor(userId, reportDate) {
      let day: Awaited<ReturnType<JournalApplicationService["readChecklist"]>> | null = null;
      try {
        day = await deps.journal.readChecklist(userId, reportDate);
      } catch {
        // `readChecklist` refuses a day that exists in neither calendar. The service reached this port
        // with a date IT resolved, so a refusal here means the caller's day was never a real day — and
        // "no data for that day" is the truthful answer, not a crash and not another day's numbers.
        return null;
      }
      // `stored: false` means "nothing was ever filed for that day". Returning null keeps the service's
      // own rule — an absent day and an absent field are both NOT_RECORDED — instead of inventing a
      // checklist whose eleven items all happen to be unreviewed.
      if (day === null || day.stored === false) return null;
      const items: Record<string, { state: string; value: string | null }> = {};
      for (const [item, entry] of Object.entries(day.list.values)) {
        items[item] = { state: entry.state, value: entry.value };
      }
      return {
        items,
        coverage: {
          confirmed: day.coverage.confirmed,
          unknown: day.coverage.unknown,
          unreviewed: day.coverage.unreviewed,
        },
        timezone: day.list.timezone,
      };
    },

    async statsFor(userId, windowKind) {
      const view = await deps.journal.stats(userId, { windowKind });
      if (view.invalidWindow === true) return null;
      const stats = view.stats;
      const mapped: PostStats = {
        closedCount: stats.closedCount,
        openCount: stats.openCount,
        winRate: stats.winRate,
        profitFactor: stats.profitFactor,
        // The journal calls it `totalPnl`; the card calls it net. Same number, no arithmetic here.
        netPnl: stats.totalPnl,
        averageR: stats.averageR,
        bestTrade: stats.bestTrade,
        worstTrade: stats.worstTrade,
        totalFees: stats.totalFees,
        averageWin: stats.averageWin,
        averageLoss: stats.averageLoss,
        windowLabel: view.label ?? windowKind,
        // The sampled flag is carried, not hidden: a post built on a bounded read has to say so, in
        // the same words the private /stats reply uses.
        sampledOf: view.sampled ? view.totalRows : null,
        flags: stats.flags,
      };
      return mapped;
    },

    async tradeFor(userId, tradeId) {
      let record: Record<string, unknown>;
      try {
        record = await deps.journal.tradeDetail(userId, tradeId);
      } catch {
        // "not yours" and "not there" arrive as the same refusal, and stay the same here: a post
        // builder must not be able to probe which trades exist under another user's id.
        return null;
      }
      const id = text(record, "id", "tradeId");
      const symbol = text(record, "symbol");
      if (id === null || symbol === null) return null;
      const mapped: PostTrade = {
        id,
        symbol,
        direction: text(record, "direction") ?? "—",
        entryPrice: text(record, "entryPrice", "openPrice"),
        exitPrice: text(record, "exitPrice", "closePrice"),
        stopLoss: text(record, "stopLoss"),
        takeProfit: text(record, "takeProfit"),
        volume: text(record, "volume", "size"),
        strategy: text(record, "strategyTag", "strategy"),
        emotion: text(record, "emotionalScore", "emotion"),
        notes: text(record, "notes"),
        openTime: text(record, "openedAt", "openTime", "occurredOpenAtUtc"),
        timezone: text(record, "timezone") ?? "UTC",
        occurredLabel: text(record, "occurredLabel", "reportDate", "occurredCloseAtUtc"),
      };
      return mapped;
    },

    todayFor: (userId) => deps.journal.todayInUserZone(userId),
  };
}
