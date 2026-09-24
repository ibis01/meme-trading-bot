import { logger } from '../utils/logger';

export type AuditEvent =
  | 'CMD_UNAUTHORIZED'
  | 'CMD_PAUSE'
  | 'CMD_RESUME'
  | 'CMD_EMERGENCY'
  | 'CMD_STATUS'
  | 'CMD_HELP'
  | 'CMD_POSITIONS'
  | 'CMD_BLOCKED_KILL_SWITCH'
  | 'CMD_BUY_PENDING'
  | 'CMD_SELL_PENDING'
  | 'CMD_CLOSEALL_PENDING'
  | 'CMD_BUY_EXECUTED'
  | 'CMD_SELL_EXECUTED'
  | 'CMD_CLOSEALL_EXECUTED';

export function audit(
  event: AuditEvent,
  data: Record<string, unknown> = {},
): void {
  logger.info({ audit: true, event, ...data }, `audit:${event}`);
}
