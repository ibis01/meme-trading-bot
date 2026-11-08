import {
  JudgeVerdict,
  parseJudge,
  BearOutput,
  BullOutput,
  SCHEMA_VERSIONS,
  PROMPT_VERSION,
} from '../src/debate/schemas';

/**
 * Schema validation contract (docs/PHASE2_DESIGN.md §9.2). Golden valid/invalid
 * judge payloads; every INVALID rule from §4 must be rejected.
 *
 * Validation rules under test:
 *   - unknown schema string → INVALID
 *   - confidence outside [0,1] → INVALID
 *   - vetoRecommended=true with stance=SUPPORT → INVALID
 *   - empty reasons → INVALID
 *   - invalid stance enum → INVALID
 *   - non-JSON → INVALID
 */

describe('debate schema validation (§9.2)', () => {
  describe('PROMPT_VERSION', () => {
    it('is a sha256-prefixed 12-hex-char tag', () => {
      expect(PROMPT_VERSION).toMatch(/^sha256:[0-9a-f]{12}$/);
    });
  });

  describe('BearOutput', () => {
    it('accepts a well-formed bear payload', () => {
      const parsed = BearOutput.parse({
        schema: SCHEMA_VERSIONS.bear,
        attacks: [{ claim: 'c', why: 'w', severity: 2 }],
        dataGaps: ['gap'],
      });
      expect(parsed.attacks[0].severity).toBe(2);
    });

    it('rejects an unknown schema string', () => {
      expect(() =>
        BearOutput.parse({ schema: 'debate.bear/v2', attacks: [], dataGaps: [] }),
      ).toThrow();
    });

    it('rejects severity outside 1-3', () => {
      expect(() =>
        BearOutput.parse({
          schema: SCHEMA_VERSIONS.bear,
          attacks: [{ claim: 'c', why: 'w', severity: 4 }],
          dataGaps: [],
        }),
      ).toThrow();
    });

    it('accepts an empty attacks array', () => {
      const parsed = BearOutput.parse({
        schema: SCHEMA_VERSIONS.bear,
        attacks: [],
        dataGaps: [],
      });
      expect(parsed.attacks).toHaveLength(0);
    });
  });

  describe('BullOutput', () => {
    it('accepts a well-formed bull payload', () => {
      const parsed = BullOutput.parse({
        schema: SCHEMA_VERSIONS.bull,
        thesis: 't',
        rebuttals: [{ attack: 'a', response: 'r' }],
        residualRisks: ['r'],
      });
      expect(parsed.thesis).toBe('t');
    });

    it('rejects an empty thesis', () => {
      expect(() =>
        BullOutput.parse({
          schema: SCHEMA_VERSIONS.bull,
          thesis: '',
          rebuttals: [],
          residualRisks: [],
        }),
      ).toThrow();
    });
  });

  describe('JudgeVerdict — valid payloads', () => {
    it('accepts SUPPORT with vetoRecommended=false', () => {
      const v: JudgeVerdict = JudgeVerdict.parse({
        schema: SCHEMA_VERSIONS.verdict,
        stance: 'SUPPORT',
        confidence: 0.7,
        vetoRecommended: false,
        reasons: ['thesis holds'],
        dataGaps: [],
      });
      expect(v.stance).toBe('SUPPORT');
    });

    it('accepts OPPOSE with vetoRecommended=true', () => {
      const v: JudgeVerdict = JudgeVerdict.parse({
        schema: SCHEMA_VERSIONS.verdict,
        stance: 'OPPOSE',
        confidence: 0.9,
        vetoRecommended: true,
        reasons: ['bear unrebutted'],
        dataGaps: [],
      });
      expect(v.vetoRecommended).toBe(true);
    });

    it('accepts ABSTAIN with vetoRecommended=false', () => {
      const v: JudgeVerdict = JudgeVerdict.parse({
        schema: SCHEMA_VERSIONS.verdict,
        stance: 'ABSTAIN',
        confidence: 0.3,
        vetoRecommended: false,
        reasons: ['insufficient evidence'],
        dataGaps: ['holder data missing'],
      });
      expect(v.stance).toBe('ABSTAIN');
    });

    it('accepts confidence at the boundaries 0 and 1', () => {
      for (const c of [0, 1]) {
        expect(() =>
          JudgeVerdict.parse({
            schema: SCHEMA_VERSIONS.verdict,
            stance: 'OPPOSE',
            confidence: c,
            vetoRecommended: false,
            reasons: ['r'],
            dataGaps: [],
          }),
        ).not.toThrow();
      }
    });
  });

  describe('JudgeVerdict — INVALID rules (§4)', () => {
    it('rejects an unknown schema string', () => {
      expect(() =>
        JudgeVerdict.parse({
          schema: 'debate.verdict/v2',
          stance: 'SUPPORT',
          confidence: 0.5,
          vetoRecommended: false,
          reasons: ['r'],
          dataGaps: [],
        }),
      ).toThrow();
    });

    it('rejects confidence > 1', () => {
      expect(() =>
        JudgeVerdict.parse({
          schema: SCHEMA_VERSIONS.verdict,
          stance: 'SUPPORT',
          confidence: 1.5,
          vetoRecommended: false,
          reasons: ['r'],
          dataGaps: [],
        }),
      ).toThrow();
    });

    it('rejects confidence < 0', () => {
      expect(() =>
        JudgeVerdict.parse({
          schema: SCHEMA_VERSIONS.verdict,
          stance: 'SUPPORT',
          confidence: -0.1,
          vetoRecommended: false,
          reasons: ['r'],
          dataGaps: [],
        }),
      ).toThrow();
    });

    it('rejects vetoRecommended=true with stance=SUPPORT (incoherent)', () => {
      expect(() =>
        JudgeVerdict.parse({
          schema: SCHEMA_VERSIONS.verdict,
          stance: 'SUPPORT',
          confidence: 0.9,
          vetoRecommended: true,
          reasons: ['r'],
          dataGaps: [],
        }),
      ).toThrow();
    });

    it('rejects empty reasons array', () => {
      expect(() =>
        JudgeVerdict.parse({
          schema: SCHEMA_VERSIONS.verdict,
          stance: 'SUPPORT',
          confidence: 0.5,
          vetoRecommended: false,
          reasons: [],
          dataGaps: [],
        }),
      ).toThrow();
    });

    it('rejects an invalid stance enum value', () => {
      expect(() =>
        JudgeVerdict.parse({
          schema: SCHEMA_VERSIONS.verdict,
          stance: 'MAYBE',
          confidence: 0.5,
          vetoRecommended: false,
          reasons: ['r'],
          dataGaps: [],
        }),
      ).toThrow();
    });
  });

  describe('parseJudge', () => {
    it('returns null for non-JSON input', () => {
      expect(parseJudge('not json')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseJudge('')).toBeNull();
    });

    it('returns the parsed verdict for a valid JSON payload', () => {
      const v = parseJudge(
        JSON.stringify({
          schema: SCHEMA_VERSIONS.verdict,
          stance: 'OPPOSE',
          confidence: 0.9,
          vetoRecommended: true,
          reasons: ['r'],
          dataGaps: [],
        }),
      );
      expect(v).not.toBeNull();
      expect(v!.stance).toBe('OPPOSE');
      expect(v!.vetoRecommended).toBe(true);
    });

    it('returns null for a payload that fails the cross-field refine', () => {
      const v = parseJudge(
        JSON.stringify({
          schema: SCHEMA_VERSIONS.verdict,
          stance: 'SUPPORT',
          confidence: 0.9,
          vetoRecommended: true, // incoherent with SUPPORT
          reasons: ['r'],
          dataGaps: [],
        }),
      );
      expect(v).toBeNull();
    });
  });
});
