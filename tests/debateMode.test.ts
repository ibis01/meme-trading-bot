import { resolveDebateMode } from '../src/debate/mode';

/**
 * Phase 2 mode matrix (docs/PHASE2_DESIGN.md §7). Single source of truth for
 * whether the debate advisor is constructed and how it behaves. Mirrors the
 * resolveStrategyGateEnabled precedent: bootstrap policy in one tested module.
 *
 * Pattern: tests/strategyGatePolicy.test.ts.
 */
const FULL_LLM = {
  llmBaseUrl: 'https://llm.example.com/v1',
  llmApiKey: 'k_test',
  llmModel: 'gpt-4o-mini',
};

describe('resolveDebateMode (Phase 2 §7 mode matrix)', () => {
  describe('off mode (default)', () => {
    it('never constructs the advisor regardless of other env', () => {
      const r = resolveDebateMode({
        mode: 'off',
        tradingMode: 'paper',
        databaseUrl: undefined,
        ...FULL_LLM,
        adviseLive: false,
      });
      expect(r.construct).toBe(false);
      expect(r.mode).toBe('off');
      expect(r.llm).toBeUndefined();
    });

    it('is off even in live mode with full env', () => {
      const r = resolveDebateMode({
        mode: 'off',
        tradingMode: 'live',
        databaseUrl: 'postgresql://x',
        ...FULL_LLM,
        adviseLive: true,
      });
      expect(r.construct).toBe(false);
    });
  });

  describe('shadow mode', () => {
    it('constructs with DATABASE_URL + LLM_* env', () => {
      const r = resolveDebateMode({
        mode: 'shadow',
        tradingMode: 'paper',
        databaseUrl: 'postgresql://x',
        ...FULL_LLM,
        adviseLive: false,
      });
      expect(r.construct).toBe(true);
      expect(r.mode).toBe('shadow');
      expect(r.llm).toEqual({
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'k_test',
        model: 'gpt-4o-mini',
      });
    });

    it('is allowed in live mode (shadow never vetoes)', () => {
      const r = resolveDebateMode({
        mode: 'shadow',
        tradingMode: 'live',
        databaseUrl: 'postgresql://x',
        ...FULL_LLM,
        adviseLive: false,
      });
      expect(r.construct).toBe(true);
      expect(r.mode).toBe('shadow');
    });

    it('is fatal without DATABASE_URL (audit trail must be persistent)', () => {
      expect(() =>
        resolveDebateMode({
          mode: 'shadow',
          tradingMode: 'paper',
          databaseUrl: undefined,
          ...FULL_LLM,
          adviseLive: false,
        }),
      ).toThrow(/DATABASE_URL/);
    });

    it('is fatal without LLM_BASE_URL', () => {
      expect(() =>
        resolveDebateMode({
          mode: 'shadow',
          tradingMode: 'paper',
          databaseUrl: 'postgresql://x',
          llmBaseUrl: undefined,
          llmApiKey: 'k',
          llmModel: 'm',
          adviseLive: false,
        }),
      ).toThrow(/LLM_BASE_URL/);
    });

    it('is fatal without LLM_API_KEY', () => {
      expect(() =>
        resolveDebateMode({
          mode: 'shadow',
          tradingMode: 'paper',
          databaseUrl: 'postgresql://x',
          llmBaseUrl: 'https://x',
          llmApiKey: undefined,
          llmModel: 'm',
          adviseLive: false,
        }),
      ).toThrow(/LLM_API_KEY/);
    });

    it('is fatal without LLM_MODEL', () => {
      expect(() =>
        resolveDebateMode({
          mode: 'shadow',
          tradingMode: 'paper',
          databaseUrl: 'postgresql://x',
          llmBaseUrl: 'https://x',
          llmApiKey: 'k',
          llmModel: undefined,
          adviseLive: false,
        }),
      ).toThrow(/LLM_MODEL/);
    });
  });

  describe('advise mode', () => {
    it('constructs in paper mode with full env', () => {
      const r = resolveDebateMode({
        mode: 'advise',
        tradingMode: 'paper',
        databaseUrl: 'postgresql://x',
        ...FULL_LLM,
        adviseLive: false,
      });
      expect(r.construct).toBe(true);
      expect(r.mode).toBe('advise');
    });

    it('is fatal in live mode without DEBATE_ADVISE_LIVE=true (dead-man switch)', () => {
      expect(() =>
        resolveDebateMode({
          mode: 'advise',
          tradingMode: 'live',
          databaseUrl: 'postgresql://x',
          ...FULL_LLM,
          adviseLive: false,
        }),
      ).toThrow(/DEBATE_ADVISE_LIVE/);
    });

    it('constructs in live mode WITH DEBATE_ADVISE_LIVE=true', () => {
      const r = resolveDebateMode({
        mode: 'advise',
        tradingMode: 'live',
        databaseUrl: 'postgresql://x',
        ...FULL_LLM,
        adviseLive: true,
      });
      expect(r.construct).toBe(true);
      expect(r.mode).toBe('advise');
    });

    it('still requires DATABASE_URL + LLM_* env', () => {
      expect(() =>
        resolveDebateMode({
          mode: 'advise',
          tradingMode: 'paper',
          databaseUrl: undefined,
          ...FULL_LLM,
          adviseLive: false,
        }),
      ).toThrow(/DATABASE_URL/);
    });
  });
});
