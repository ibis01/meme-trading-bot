import { DebateService, DebateConfig } from '../src/debate/service';
import { InMemoryDebateStore } from '../src/state/debateVerdicts';
import { LlmClient, ChatCompletionResult, ChatCompletionRequest } from '../src/llm/types';
import { Signal } from '../src/strategy/types';
import { TokenSecurityEvidence } from '../src/security/types';

/**
 * DebateService contract (docs/PHASE2_DESIGN.md §9.3). Uses a fake LlmClient
 * with canned transcripts — no real LLM, no network.
 *
 * Covers: full debate persistence, per-role failure → UNAVAILABLE, budget
 * window cap, daily cap, failure breaker OPEN/CLOSE, same signal twice → 1
 * row (UNIQUE), BUY-only (SELL signals skip), veto computation, INVALID judge
 * output, shadow mode never vetoes.
 */

const security: TokenSecurityEvidence = {
  tokenMint: 'mint',
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  top10HolderPercent: 20,
  devWalletPercent: 2,
  liquidityUsd: 100_000,
  sellabilityConfirmed: true,
  fetchedAt: Date.now(),
  source: 'mock',
};

function makeSignal(id = 'sig_1', side: 'BUY' | 'SELL' = 'BUY'): Signal {
  return {
    id,
    tokenMint: 'mint',
    strategy: 'MEME_MOMENTUM_V1',
    strategyVersion: '1.0.0',
    createdAt: Date.now(),
    side,
    score: 80,
    proposedAmountSol: 0.05,
    proposedSlippageBps: 100,
    proposedPriceImpactBps: 150,
    evidence: {
      marketSnapshot: {
        tokenMint: 'mint', fetchedAt: Date.now(), priceUsd: 0.001,
        liquidityUsd: 100_000, volume24hUsd: 500_000, holderCount: 1000,
        top10HolderPercent: 20, smartWalletNetFlowUsd: 5000,
        priceChange5mPercent: 5, priceChange1hPercent: 10,
      },
      indicators: {}, entryReason: 'test',
    },
  };
}

/** A fake client where each role's response is a canned string. */
class FakeLlmClient implements LlmClient {
  public calls: ChatCompletionRequest[] = [];
  constructor(
    private readonly responses: { bear: string; bull: string; judge: string },
    private readonly failAt?: 'bear' | 'bull' | 'judge',
  ) {}

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.calls.push(req);
    // The role is identifiable by the system prompt's "You are the X" prefix.
    const sys = req.messages[0]?.content ?? '';
    let key: 'bear' | 'bull' | 'judge';
    if (sys.startsWith('You are the BEAR')) key = 'bear';
    else if (sys.startsWith('You are the BULL')) key = 'bull';
    else if (sys.startsWith('You are the JUDGE')) key = 'judge';
    else throw new Error('unknown role in fake');

    if (this.failAt && key === this.failAt) {
      throw new Error(`${key}_FAKE_FAILURE`);
    }
    return {
      content: this.responses[key],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 1,
    };
  }
}

const BEAR_OK = JSON.stringify({
  schema: 'debate.bear/v1',
  attacks: [{ claim: 'thin liq', why: 'low liquidity', severity: 2 }],
  dataGaps: [],
});
const BULL_OK = JSON.stringify({
  schema: 'debate.bull/v1',
  thesis: 'momentum + smart money inflow',
  rebuttals: [{ attack: 'thin liq', response: 'above 50k threshold' }],
  residualRisks: ['sudden dump'],
});
const JUDGE_SUPPORT = JSON.stringify({
  schema: 'debate.verdict/v1',
  stance: 'SUPPORT',
  confidence: 0.7,
  vetoRecommended: false,
  reasons: ['thesis holds'],
  dataGaps: [],
});
const JUDGE_OPPOSE_VETO = JSON.stringify({
  schema: 'debate.verdict/v1',
  stance: 'OPPOSE',
  confidence: 0.9,
  vetoRecommended: true,
  reasons: ['bear case unrebutted', 'sellability unconfirmed'],
  dataGaps: [],
});
const JUDGE_OPPOSE_LOW_CONF = JSON.stringify({
  schema: 'debate.verdict/v1',
  stance: 'OPPOSE',
  confidence: 0.5,
  vetoRecommended: true,
  reasons: ['uncertain'],
  dataGaps: [],
});
const JUDGE_INVALID_SCHEMA = JSON.stringify({
  schema: 'debate.verdict/v2', // wrong schema
  stance: 'SUPPORT',
  confidence: 0.5,
  vetoRecommended: false,
  reasons: ['x'],
  dataGaps: [],
});
const JUDGE_INVALID_VETO_SUPPORT = JSON.stringify({
  schema: 'debate.verdict/v1',
  stance: 'SUPPORT',
  confidence: 0.9,
  vetoRecommended: true, // incoherent with SUPPORT
  reasons: ['x'],
  dataGaps: [],
});
const JUDGE_INVALID_CONFIDENCE = JSON.stringify({
  schema: 'debate.verdict/v1',
  stance: 'OPPOSE',
  confidence: 1.5, // out of range
  vetoRecommended: false,
  reasons: ['x'],
  dataGaps: [],
});

function baseConfig(overrides: Partial<DebateConfig> = {}): DebateConfig {
  return {
    mode: 'advise',
    model: 'gpt-4o-mini',
    perCallTimeoutMs: 6000,
    vetoConfidence: 0.8,
    windowMax: 8,
    windowMs: 60_000,
    dailyMax: 300,
    dailyBudgetUsd: 2.0,
    failureBreakerThreshold: 5,
    failureBreakerOpenMs: 15 * 60 * 1000,
    claimLeaseMs: 60_000,
    ...overrides,
  };
}

function makeService(
  client: LlmClient,
  cfg: DebateConfig = baseConfig(),
  now?: () => number,
): { service: DebateService; store: InMemoryDebateStore } {
  const store = new InMemoryDebateStore();
  const service = new DebateService(client, store, cfg, now);
  return { service, store };
}

describe('DebateService', () => {
  describe('happy path (COMPLETED)', () => {
    it('runs Bear→Bull→Judge, persists a COMPLETED row, returns the verdict', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const { service, store } = makeService(client);
      const signal = makeSignal();
      const res = await service.advise({ signal, tradeRequestId: 'sig:sig_1', security });

      expect(res.kind).toBe('COMPLETED');
      expect(res.stance).toBe('SUPPORT');
      expect(res.confidence).toBe(0.7);
      expect(res.vetoRecommended).toBe(false);
      expect(res.shouldVeto).toBe(false);
      expect(res.verdict).toBeDefined();

      // Exactly 3 LLM calls, in order Bear→Bull→Judge.
      expect(client.calls).toHaveLength(3);
      expect(client.calls[0].messages[0].content).toContain('BEAR');
      expect(client.calls[1].messages[0].content).toContain('BULL');
      expect(client.calls[2].messages[0].content).toContain('JUDGE');

      // Bull sees Bear's output; Judge sees both.
      const bullUser = client.calls[1].messages[1].content;
      expect(bullUser).toContain('BEAR ATTACKS');
      const judgeUser = client.calls[2].messages[1].content;
      expect(judgeUser).toContain('BEAR ATTACKS');
      expect(judgeUser).toContain('BULL THESIS');

      // Row persisted.
      const row = await store.getBySignal('sig_1', 'advise');
      expect(row).not.toBeNull();
      expect(row!.outcome).toBe('COMPLETED');
      expect(row!.stance).toBe('SUPPORT');
      expect(row!.model).toBe('gpt-4o-mini');
      expect(row!.verdict).not.toBeNull();
      expect(row!.transcript.roles).toHaveLength(3);
    });

    it('veto fires in advise mode when OPPOSE + vetoRecommended + confidence >= threshold', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_OPPOSE_VETO,
      });
      const { service } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('COMPLETED');
      expect(res.shouldVeto).toBe(true);
      expect(res.stance).toBe('OPPOSE');
      expect(res.confidence).toBe(0.9);
    });

    it('does NOT veto when confidence is below the threshold', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_OPPOSE_LOW_CONF,
      });
      const { service } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('COMPLETED');
      expect(res.stance).toBe('OPPOSE');
      expect(res.vetoRecommended).toBe(true);
      expect(res.confidence).toBe(0.5);
      expect(res.shouldVeto).toBe(false); // 0.5 < 0.8 threshold
    });
  });

  describe('shadow mode never vetoes', () => {
    it('returns shouldVeto=false even with a veto verdict in shadow mode', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_OPPOSE_VETO,
      });
      const { service } = makeService(client, baseConfig({ mode: 'shadow' }));
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('COMPLETED');
      expect(res.stance).toBe('OPPOSE');
      expect(res.vetoRecommended).toBe(true);
      expect(res.shouldVeto).toBe(false); // shadow never vetoes
    });
  });

  describe('per-role failure → UNAVAILABLE', () => {
    it('records UNAVAILABLE when Bear fails', async () => {
      const client = new FakeLlmClient(
        { bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT },
        'bear',
      );
      const { service, store } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('UNAVAILABLE');
      expect(res.shouldVeto).toBe(false);
      const row = await store.getBySignal('sig_1', 'advise');
      expect(row!.outcome).toBe('UNAVAILABLE');
      expect(row!.transcript).toHaveProperty('reasonCode', 'BEAR_FAILED');
    });

    it('records UNAVAILABLE when Bull fails (Bear already called)', async () => {
      const client = new FakeLlmClient(
        { bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT },
        'bull',
      );
      const { service, store } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('UNAVAILABLE');
      expect(client.calls).toHaveLength(2); // Bear + Bull attempted
      const row = await store.getBySignal('sig_1', 'advise');
      expect(row!.outcome).toBe('UNAVAILABLE');
    });

    it('records UNAVAILABLE when Judge fails (Bear+Bull already called)', async () => {
      const client = new FakeLlmClient(
        { bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT },
        'judge',
      );
      const { service, store } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('UNAVAILABLE');
      expect(client.calls).toHaveLength(3);
      const row = await store.getBySignal('sig_1', 'advise');
      expect(row!.outcome).toBe('UNAVAILABLE');
    });
  });

  describe('INVALID judge output', () => {
    it('records INVALID when the judge output has the wrong schema string', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_INVALID_SCHEMA,
      });
      const { service, store } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('INVALID');
      expect(res.shouldVeto).toBe(false);
      const row = await store.getBySignal('sig_1', 'advise');
      expect(row!.outcome).toBe('INVALID');
      expect(row!.verdict).toBeNull();
    });

    it('records INVALID when vetoRecommended=true with stance=SUPPORT', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_INVALID_VETO_SUPPORT,
      });
      const { service } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('INVALID');
    });

    it('records INVALID when confidence is out of [0,1]', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_INVALID_CONFIDENCE,
      });
      const { service } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('INVALID');
    });

    it('records INVALID when the judge output is not valid JSON', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: 'this is not json at all',
      });
      const { service } = makeService(client);
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('INVALID');
    });
  });

  describe('idempotency (UNIQUE signal_id + mode)', () => {
    it('returns a CACHED result and makes no LLM calls when the signal was already debated', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const { service } = makeService(client);
      await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(client.calls).toHaveLength(3);

      // Second call with the same signal id → CACHED, no new LLM calls.
      const res2 = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res2.kind).toBe('CACHED');
      expect(res2.shouldVeto).toBe(false);
      expect(client.calls).toHaveLength(3); // unchanged
    });
  });

  describe('rolling-window cap', () => {
    it('skips (SKIPPED) when the window cap is reached', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const { service, store } = makeService(client, baseConfig({ windowMax: 2, windowMs: 60_000 }));
      // 2 debates fill the window.
      await service.advise({ signal: makeSignal('s1'), tradeRequestId: 'sig:s1', security });
      await service.advise({ signal: makeSignal('s2'), tradeRequestId: 'sig:s2', security });
      // 3rd is skipped.
      const res = await service.advise({ signal: makeSignal('s3'), tradeRequestId: 'sig:s3', security });
      expect(res.kind).toBe('SKIPPED');
      expect(res.reason).toBe('WINDOW_CAP');
      expect(client.calls).toHaveLength(6); // 2 debates × 3 calls
      // No row for the skipped signal.
      expect(await store.getBySignal('s3', 'advise')).toBeNull();
    });
  });

  describe('daily call cap', () => {
    it('skips (SKIPPED) when the daily cap is reached', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const { service } = makeService(client, baseConfig({ dailyMax: 1 }));
      await service.advise({ signal: makeSignal('s1'), tradeRequestId: 'sig:s1', security });
      const res = await service.advise({ signal: makeSignal('s2'), tradeRequestId: 'sig:s2', security });
      expect(res.kind).toBe('SKIPPED');
      expect(res.reason).toBe('DAILY_CAP');
    });
  });

  describe('consecutive-failure circuit breaker', () => {
    it('opens after the threshold and skips subsequent debates', async () => {
      // Bear always fails.
      const client = new FakeLlmClient(
        { bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT },
        'bear',
      );
      const { service } = makeService(
        client,
        baseConfig({ failureBreakerThreshold: 2, failureBreakerOpenMs: 60_000 }),
      );
      // 2 consecutive failures → breaker opens.
      const r1 = await service.advise({ signal: makeSignal('s1'), tradeRequestId: 'sig:s1', security });
      const r2 = await service.advise({ signal: makeSignal('s2'), tradeRequestId: 'sig:s2', security });
      expect(r1.kind).toBe('UNAVAILABLE');
      expect(r2.kind).toBe('UNAVAILABLE');
      // 3rd is skipped because the breaker is open.
      const r3 = await service.advise({ signal: makeSignal('s3'), tradeRequestId: 'sig:s3', security });
      expect(r3.kind).toBe('SKIPPED');
      expect(r3.reason).toBe('CIRCUIT_OPEN');
    });

    it('resets on a success', async () => {
      // Use a client that fails Bear twice, then succeeds.
      let callCount = 0;
      const failClient = new FakeLlmClient(
        { bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT },
        'bear',
      );
      const okClient = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const combined: LlmClient = {
        async chat(req) {
          callCount++;
          // First 1 call (bear of debate 1) fails; after that succeed.
          if (callCount === 1) return failClient.chat(req);
          return okClient.chat(req);
        },
      };
      const { service } = makeService(
        combined,
        baseConfig({ failureBreakerThreshold: 3, failureBreakerOpenMs: 60_000 }),
      );
      // Debate 1: Bear fails → 1 failure.
      const r1 = await service.advise({ signal: makeSignal('s1'), tradeRequestId: 'sig:s1', security });
      expect(r1.kind).toBe('UNAVAILABLE');
      // Debate 2: succeeds → failure counter resets.
      const r2 = await service.advise({ signal: makeSignal('s2'), tradeRequestId: 'sig:s2', security });
      expect(r2.kind).toBe('COMPLETED');
      // Debate 3: should NOT be skipped (breaker never opened, counter reset).
      const r3 = await service.advise({ signal: makeSignal('s3'), tradeRequestId: 'sig:s3', security });
      expect(r3.kind).toBe('COMPLETED');
    });
  });

  describe('never throws (fail-open)', () => {
    it('returns UNAVAILABLE when the store.save throws, instead of propagating', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const badStore = new InMemoryDebateStore();
      // Make save reject.
      badStore.save = jest.fn().mockRejectedValue(new Error('db down'));
      const service = new DebateService(client, badStore, baseConfig());
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      // Fail-open to UNAVAILABLE, never a throw.
      expect(['UNAVAILABLE']).toContain(res.kind);
      expect(res.shouldVeto).toBe(false);
    });

    // Audit fix #4: the ENTIRE debate lifecycle — including the very first
    // verdict lookup — is inside fail-open handling. A DB outage must never
    // throw out of advise() and must never reach the LLM.
    it('audit #4: store.getBySignal throwing → SKIPPED STORE_LOOKUP_FAILED, zero LLM calls, no throw', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const badStore = new InMemoryDebateStore();
      badStore.getBySignal = jest.fn().mockRejectedValue(new Error('db down'));
      const service = new DebateService(client, badStore, baseConfig());
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('SKIPPED');
      expect(res.reason).toBe('STORE_LOOKUP_FAILED');
      expect(res.shouldVeto).toBe(false);
      expect(client.calls).toHaveLength(0); // no spend before the claim
    });

    it('audit #4: store.tryClaim throwing → SKIPPED STORE_CLAIM_FAILED, zero LLM calls, no throw', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const badStore = new InMemoryDebateStore();
      badStore.tryClaim = jest.fn().mockRejectedValue(new Error('db down'));
      const service = new DebateService(client, badStore, baseConfig());
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('SKIPPED');
      expect(res.reason).toBe('STORE_CLAIM_FAILED');
      expect(res.shouldVeto).toBe(false);
      expect(client.calls).toHaveLength(0);
    });
  });

  describe('claim-based idempotency (audit fix #5 — no concurrent double-spend)', () => {
    it('two concurrent advise() calls for the same signal → exactly ONE runs the protocol', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      // Add latency so both callers truly overlap in the claim window.
      const slowClient: LlmClient = {
        async chat(req) {
          await new Promise((r) => setTimeout(r, 10));
          return client.chat(req);
        },
      };
      const { service, store } = makeService(slowClient);
      const signal = makeSignal();
      const [a, b] = await Promise.all([
        service.advise({ signal, tradeRequestId: 'sig:sig_1', security }),
        service.advise({ signal, tradeRequestId: 'sig:sig_1', security }),
      ]);

      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['COMPLETED', 'SKIPPED']);
      const skipped = a.kind === 'SKIPPED' ? a : b;
      expect(skipped.reason).toBe('DEBATE_IN_PROGRESS');
      expect(skipped.shouldVeto).toBe(false);
      // Exactly one debate's worth of LLM spend — the audit's core demand.
      expect(client.calls).toHaveLength(3);
      // The claim was released after the debate completed.
      expect(store.claimCount()).toBe(0);
    });

    it('re-advise after a completed debate still returns CACHED (cache layer intact)', async () => {
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const { service } = makeService(client);
      await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      const res = await service.advise({ signal: makeSignal(), tradeRequestId: 'sig:sig_1', security });
      expect(res.kind).toBe('CACHED');
      expect(client.calls).toHaveLength(3);
    });

    it('an expired lease (crashed worker) is stolen by the next caller', async () => {
      let t = 1_000_000;
      const client = new FakeLlmClient({
        bear: BEAR_OK, bull: BULL_OK, judge: JUDGE_SUPPORT,
      });
      const { service, store } = makeService(client, baseConfig({ claimLeaseMs: 5_000 }), () => t);

      // First debate claims and releases cleanly.
      const r1 = await service.advise({ signal: makeSignal('s1'), tradeRequestId: 'sig:s1', security });
      expect(r1.kind).toBe('COMPLETED');
      expect(store.claimCount()).toBe(0);

      // Simulate a crashed worker holding a stale claim.
      const { token } = await store.tryClaim('s2', 'advise', 5_000, t);
      expect(token).not.toBeNull();
      t += 6_000; // lease expires
      const r2 = await service.advise({ signal: makeSignal('s2'), tradeRequestId: 'sig:s2', security });
      expect(r2.kind).toBe('COMPLETED'); // stolen and debated
      expect(client.calls).toHaveLength(6); // 3 (s1) + 3 (s2 after the steal)
    });
  });
});
