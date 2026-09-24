import { ExitRules } from '../src/backtest/exitRules';
import { OpenPosition, StopConfig } from '../src/backtest/types';

const position = (o: Partial<OpenPosition> = {}): OpenPosition => ({
  tokenMint: 'mint',
  entryIndex: 0,
  entryPriceUsd: 1.0,
  entryAt: 1_700_000_000_000,
  amountSol: 0.1,
  highWatermarkUsd: 1.0,
  ...o,
});

describe('ExitRules (Rule 16)', () => {
  const cfg: StopConfig = { hardStopPct: 0.15, trailingStopPct: 0.1, timeStopMs: 60 * 60 * 1000 };

  it('rejects invalid stop config', () => {
    expect(() => new ExitRules({ hardStopPct: 0 })).toThrow();
    expect(() => new ExitRules({ hardStopPct: 1 })).toThrow();
    expect(() => new ExitRules({ hardStopPct: 0.1, trailingStopPct: -0.1 })).toThrow();
    expect(() => new ExitRules({ hardStopPct: 0.1, timeStopMs: 0 })).toThrow();
  });

  it('does not fire on a profitable hold', () => {
    const rules = new ExitRules(cfg);
    const p = position();
    const r = rules.evaluate(p, 1.05, 1_700_000_000_000 + 1000);
    expect(r.shouldExit).toBe(false);
  });

  it('fires HARD_STOP when price drops past hard stop', () => {
    const rules = new ExitRules(cfg);
    const r = rules.evaluate(position(), 0.8, 1_700_000_000_000 + 1000);
    expect(r.shouldExit).toBe(true);
    expect(r.reason).toBe('HARD_STOP');
  });

  it('fires TRAILING_STOP after price pulls back from HWM', () => {
    const rules = new ExitRules(cfg);
    const p = position({ highWatermarkUsd: 1.5 });
    const r = rules.evaluate(p, 1.3, 1_700_000_000_000 + 1000);
    expect(r.shouldExit).toBe(true);
    expect(r.reason).toBe('TRAILING_STOP');
  });

  it('fires TIME_STOP after max hold duration', () => {
    const rules = new ExitRules(cfg);
    const r = rules.evaluate(position(), 1.0, 1_700_000_000_000 + 3600_000);
    expect(r.shouldExit).toBe(true);
    expect(r.reason).toBe('TIME_STOP');
  });

  it('time stop takes priority over hard stop', () => {
    const rules = new ExitRules(cfg);
    const r = rules.evaluate(position(), 0.1, 1_700_000_000_000 + 3600_000);
    expect(r.reason).toBe('TIME_STOP');
  });

  it('updateHighWatermark only increases', () => {
    const rules = new ExitRules(cfg);
    const p = position({ highWatermarkUsd: 1.2 });
    expect(rules.updateHighWatermark(p, 1.1).highWatermarkUsd).toBe(1.2);
    expect(rules.updateHighWatermark(p, 1.3).highWatermarkUsd).toBe(1.3);
  });
});
