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
    logger.warn('TELEGRAM_AUTHORIZED_USER_IDS empty — all commands will be rejected.');
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

  const reply = async (msg: { from?: { id?: number }; reply: (s: string) => unknown }, r: { message: string }) => {
    await msg.reply(r.message);
  };

  bot.command('help', (m) => reply(m, { message: '' }).then(() => handleHelp(ctx(m.from?.id)).then((r) => m.reply(r.message))));
  bot.command('status', (m) => handleStatus(ctx(m.from?.id)).then((r) => m.reply(r.message)));
  bot.command('positions', (m) => handlePositions(ctx(m.from?.id)).then((r) => m.reply(r.message)));
  bot.command('pause', (m) => handlePause(ctx(m.from?.id)).then((r) => m.reply(r.message)));
  bot.command('resume', (m) => handleResume(ctx(m.from?.id)).then((r) => m.reply(r.message)));
  bot.command('emergency', (m) => handleEmergency(ctx(m.from?.id)).then((r) => m.reply(r.message)));

  bot.command('buy', (m) => {
    const text = (m.message as { text?: string }).text ?? '';
    const args = text.split(/\s+/).slice(1);
    return handleBuy(ctx(m.from?.id), args).then((r) => m.reply(r.message));
  });
  bot.command('sell', (m) => {
    const text = (m.message as { text?: string }).text ?? '';
    const args = text.split(/\s+/).slice(1);
    return handleSell(ctx(m.from?.id), args).then((r) => m.reply(r.message));
  });
  bot.command('closeall', (m) => handleCloseAll(ctx(m.from?.id)).then((r) => m.reply(r.message)));

  // Free-text confirmation handler
  bot.on('text', async (m) => {
    const text = (m.message as { text?: string }).text ?? '';
    if (text.startsWith('/')) return; // handled above
    const result = await handleConfirmationText(ctx(m.from?.id), text);
    if (result) await m.reply(result.message);
  });

  bot.launch().catch((err) => logger.error({ err }, 'Telegram launch failed'));
  logger.info({ authorizedIds }, 'Telegram bot started');
  return bot;
}
