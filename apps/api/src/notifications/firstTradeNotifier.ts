// FirstTradeNotifier — the post-create side effect Legacy TradeService ran
// inline (MG-EMAIL-TYPES): after a trade is durable, a user whose ACTIVE
// trade count is exactly 1 receives the first-trade email, and the
// FIRST_TRADE achievement unlock (first time only) sends its email.
//
// Extracted from the server-main composition root so the DECISION is
// testable: this adapter is the single implementation of the
// TradeServiceDeps.onTradeCreated hook, reused by BOTH the HTTP trades
// service and the Telegram journal service (Legacy had ONE TradeService for
// every ingestion surface — the side effect fired for both).
//
// Fail-silent by contract (Legacy wrapped the whole block in try/catch): the
// trade already exists; a notification failure must never undo it.

import {
  ACHIEVEMENTS,
  unlockAchievement,
  type AchievementStore,
} from "@velora/domain";
import type { NotificationService } from "./notificationService.js";

export interface FirstTradeNotifierDeps {
  readonly notifications: NotificationService;
  readonly achievements: AchievementStore;
  /** Active-trade count for the user (the trade store's search total). */
  readonly countActiveTrades: (userId: string) => Promise<number>;
  /** Owner lookup for email/name/locale. Null short-circuits. */
  readonly findUser: (userId: string) => Promise<{
    id: string;
    email: string;
    fullName: string | null;
    locale: string | null | undefined;
  } | null>;
}

export class FirstTradeNotifier {
  constructor(private readonly deps: FirstTradeNotifierDeps) {}

  /** The TradeServiceDeps.onTradeCreated hook. Never throws. */
  async onTradeCreated(input: {
    userId: string;
    symbol: string;
    direction: string;
  }): Promise<void> {
    try {
      const count = await this.deps.countActiveTrades(input.userId);
      if (count !== 1) return; // not the first trade — Legacy: === 1
      const user = await this.deps.findUser(input.userId);
      if (user === null) return;
      const locale = user.locale === "en" ? "en" : "fa";
      const recipient = {
        userId: user.id,
        email: user.email,
        fullName: user.fullName,
        locale: user.locale,
      };
      await this.deps.notifications.sendFirstTradeEmail(
        recipient,
        { symbol: input.symbol, direction: input.direction },
        locale,
      );
      const firstUnlock = await unlockAchievement(
        input.userId,
        ACHIEVEMENTS["FIRST_TRADE"]!,
        this.deps.achievements,
      );
      if (firstUnlock) {
        await this.deps.notifications.sendAchievementUnlockedEmail(
          recipient,
          {
            achievementTitle: ACHIEVEMENTS["FIRST_TRADE"]!.titleKey,
            achievementDescription: ACHIEVEMENTS["FIRST_TRADE"]!.descriptionKey,
          },
          locale,
        );
      }
    } catch {
      /* fail-silent — Legacy parity */
    }
  }
}
