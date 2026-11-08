import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { z } from 'zod';
import { logger } from '../utils/logger';

// ── Prompt loading + versioning ────────────────────────────────────────
// Prompts are versioned source files. A hash of each prompt is recorded per
// debate row so a verdict can always be tied back to the exact prompt text
// that produced it.

const PROMPTS_DIR = path.resolve(__dirname, 'prompts');

function loadPrompt(name: 'bear' | 'bull' | 'judge'): string {
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  return fs.readFileSync(file, 'utf8');
}

export const BEAR_PROMPT = loadPrompt('bear');
export const BULL_PROMPT = loadPrompt('bull');
export const JUDGE_PROMPT = loadPrompt('judge');

/** Short version tag recorded per row; the full hash is in PROMPT_VERSION. */
export const PROMPT_VERSION = (() => {
  const h = createHash('sha256');
  h.update(BEAR_PROMPT);
  h.update('\u0000');
  h.update(BULL_PROMPT);
  h.update('\u0000');
  h.update(JUDGE_PROMPT);
  // First 12 hex chars — enough to detect any prompt change, short for a column.
  return `sha256:${h.digest('hex').slice(0, 12)}`;
})();

/** Schema version strings embedded in role outputs and asserted on parse. */
export const SCHEMA_VERSIONS = {
  bear: 'debate.bear/v1',
  bull: 'debate.bull/v1',
  verdict: 'debate.verdict/v1',
} as const;

// ── Zod schemas (§4 of the design) ─────────────────────────────────────

export const BearOutput = z.object({
  schema: z.literal(SCHEMA_VERSIONS.bear),
  attacks: z
    .array(
      z.object({
        claim: z.string().min(1),
        why: z.string().min(1),
        severity: z.number().int().min(1).max(3),
      }),
    )
    .min(0),
  dataGaps: z.array(z.string()).min(0),
});
export type BearOutput = z.infer<typeof BearOutput>;

export const BullOutput = z.object({
  schema: z.literal(SCHEMA_VERSIONS.bull),
  thesis: z.string().min(1),
  rebuttals: z
    .array(
      z.object({
        attack: z.string().min(1),
        response: z.string().min(1),
      }),
    )
    .min(0),
  residualRisks: z.array(z.string()).min(0),
});
export type BullOutput = z.infer<typeof BullOutput>;

export const VerdictStance = z.enum(['SUPPORT', 'OPPOSE', 'ABSTAIN']);
export type VerdictStance = z.infer<typeof VerdictStance>;

/**
 * Judge verdict — the only output that matters downstream.
 *
 * Validation rules (§4): unknown schema string → INVALID; confidence outside
 * [0,1] → INVALID; vetoRecommended=true with stance=SUPPORT → INVALID; empty
 * reasons → INVALID. The cross-field rule is enforced with `.refine` so the
 * whole object fails atomically.
 */
export const JudgeVerdict = z
  .object({
    schema: z.literal(SCHEMA_VERSIONS.verdict),
    stance: VerdictStance,
    confidence: z.number().min(0).max(1),
    vetoRecommended: z.boolean(),
    reasons: z.array(z.string().min(1)).min(1),
    dataGaps: z.array(z.string()).min(0),
  })
  .refine(
    (v) => !(v.vetoRecommended && v.stance === 'SUPPORT'),
    {
      message: 'vetoRecommended=true with stance=SUPPORT is incoherent',
      path: ['vetoRecommended'],
    },
  );
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/**
 * Parse a role output. Returns null on any validation failure (the caller
 * records INVALID — Rule 23: never silently swallow, the row makes it
 * observable). Logs the parse error so INVALID rows are debuggable.
 */
export function parseJudge(content: string): JudgeVerdict | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    logger.warn(
      { event: 'DEBATE_INVALID_OUTPUT', stage: 'judge.parse', err: errMsg(err) },
      'Judge output was not valid JSON',
    );
    return null;
  }
  const parsed = JudgeVerdict.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      {
        event: 'DEBATE_INVALID_OUTPUT',
        stage: 'judge.schema',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      'Judge output failed schema validation',
    );
    return null;
  }
  return parsed.data;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
