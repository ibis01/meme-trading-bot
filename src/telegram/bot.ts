import { Telegraf } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Authorizer, parseAuthorizedIds } from './auth';
import { RedisKillSwitch } from '../state/killSwitch';
import { getRedis } from '../infra/redis';
import { ConfirmationManager } from './confirmation';
import {
  CommandContext,
  handleBuy,
  handleCloseAll,
  handleConfirmationText,
  handleEmergency,
  handleHelp,
  handlePause,
  handlePositions,
  handleResume,
  handleSell,
  handleStatus,
} from './commands';

export interface TelegramDeps {
  positions: CommandContext['positions'];
  proposals: CommandContext['proposals'];
  onTradeRequest?: CommandContext['onTradeRequest'];
  onCloseAll?: CommandContext['onCloseAll'];
}

export function startTelegramBot(deps: TelegramDeps): Telegraf | null {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.');
    return null;
  }

  const authorizedIds = parseAuthorizedIds(config.TELEGRAM_AUTHORIZED_USER_IDS);
  if (authorizedIds.length === 0) {
    logger.warn(
      'TELEGRAM_AUTHORIZED_USER_IDS empty — all commands will be rejected.',
    );
  }

  const authorizer = new Authorizer(authorizedIds);
  const killSwitch = new RedisKillSwitch(getRedis() as never);
  const confirmations = new ConfirmationManager(60_000);
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

  const ctx = (userId?: number): CommandContext => ({
    userId,
    authorizer,
    killSwitch,
    positions: deps.positions,
    proposals: deps.proposals,
    confirmations,
    onTradeRequest: deps.onTradeRequest,
    onCloseAll: deps.onCloseAll,
  });

  /**
   * Audit fix H3: every handler previously returned an uncaught promise —
   * a rejection (e.g. Redis hiccup inside a kill-switch read) surfaced as a
   * silent Telegraf-internal error: the user got no reply and nobody was
   * told. Wrap everything: answer the user, log, audit.
   */
  const safeReply = async (
    m: { from?: { id?: number }; reply: (s: string) => unknown },
    fn: (c: CommandContext) => Promise<{ ok: boolean; message: string }>,
  ): Promise<void> => {
    try {
      const r = await fn(ctx(m.from?.id));
      // Empty message = handler chose to stay silent (e.g. free text that is
      // not a confirmation). Never send '' — the Bot API rejects it.
      if (r.message) await m.reply(r.message);
    } catch (err) {
      logger.error(
        { event: 'TG_HANDLER_ERROR', userId: m.from?.id, err },
        'Telegram command failed',
      );
      try {
        await m.reply(
          '⚠️ Internal error handling that command. Check bot logs.',
        );
      } catch {
        /* nothing more we can do */
      }
    }
  };

  bot.command('help', (m) => safeReply(m, (c) => handleHelp(c)));
  bot.command('status', (m) => safeReply(m, (c) => handleStatus(c)));
  bot.command('positions', (m) => safeReply(m, (c) => handlePositions(c)));
  bot.command('pause', (m) => safeReply(m, (c) => handlePause(c)));
  bot.command('resume', (m) => safeReply(m, (c) => handleResume(c)));
  bot.command('emergency', (m) => safeReply(m, (c) => handleEmergency(c)));
  bot.command('closeall', (m) => safeReply(m, (c) => handleCloseAll(c)));

  bot.command('buy', (m) =>
    safeReply(m, async (c) => {
      const text = (m.message as { text?: string }).text ?? '';
      return handleBuy(c, text.split(/\s+/).slice(1));
    }),
  );
  bot.command('sell', (m) =>
    safeReply(m, async (c) => {
      const text = (m.message as { text?: string }).text ?? '';
      return handleSell(c, text.split(/\s+/).slice(1));
    }),
  );

  // Free-text confirmation handler
  bot.on('text', (m) =>
    safeReply(m, async (c) => {
      const text = (m.message as { text?: string }).text ?? '';
      if (text.startsWith('/')) return { ok: true, message: '' }; // handled by commands above
      const result = await handleConfirmationText(c, text);
      return result ?? { ok: true, message: '' }; // not a confirmation — stay silent
    }),
  );

  // Audit fix H3: last-resort error handler so nothing escapes unobserved.
  bot.catch((err, m) => {
    logger.error(
      { event: 'TG_UNHANDLED_ERROR', err, updateId: m?.update?.update_id },
      'Unhandled Telegraf error',
    );
  });

  // dropPendingUpdates: a restart must not replay stale /buy or /resume
  // commands that were queued while the process was down (audit, Low).
  bot
    .launch({ dropPendingUpdates: true })
    .catch((err) => logger.error({ err }, 'Telegram launch failed'));
  logger.info({ authorizedIds }, 'Telegram bot started');
  return bot;
}
