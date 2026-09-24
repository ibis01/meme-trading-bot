import { RaydiumDecoder, MeteoraDecoder, OrcaDecoder, DecoderRegistry } from '../src/data/poolEvents/decoders';
import { PoolEvent } from '../src/data/poolEvents/types';

const VALID_A = 'So11111111111111111111111111111111111111112';
const VALID_B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const VALID_C = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const VALID_POOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ctx = {
  signature: 'sig1',
  slot: 100,
  blockTimeMs: 1_700_000_000_000,
  allAccountKeys: [VALID_A, VALID_B],
};

describe('RaydiumDecoder', () => {
  const d = new RaydiumDecoder();

  it('extracts pool address, mints, creator from initialize2', () => {
    const accounts = Array(20).fill(VALID_A);
    accounts[4] = VALID_POOL;
    accounts[8] = VALID_B;
    accounts[9] = VALID_C;
    accounts[17] = VALID_A;
    const ix = { programId: d.programIds[0], accounts, data: Buffer.from([1, 0, 0, 0]) };
    const event: PoolEvent | null = d.decode(ix, ctx);
    expect(event).not.toBeNull();
    expect(event!.dex).toBe('raydium');
    expect(event!.poolAddress).toBe(VALID_POOL);
    expect(event!.baseMint).toBe(VALID_B);
    expect(event!.quoteMint).toBe(VALID_C);
    expect(event!.creatorWallet).toBe(VALID_A);
  });

  it('returns null for non-initialize instructions', () => {
    const ix = { programId: d.programIds[0], accounts: Array(20).fill(VALID_A), data: Buffer.from([9, 0, 0, 0]) };
    expect(d.decode(ix, ctx)).toBeNull();
  });

  it('returns null if accounts are missing', () => {
    const ix = { programId: d.programIds[0], accounts: [VALID_A, VALID_B], data: Buffer.from([1]) };
    expect(d.decode(ix, ctx)).toBeNull();
  });

  it('returns null if pool address is not a plausible pubkey', () => {
    const accounts = Array(20).fill(VALID_A);
    accounts[4] = 'not-a-pubkey';
    const ix = { programId: d.programIds[0], accounts, data: Buffer.from([1]) };
    expect(d.decode(ix, ctx)).toBeNull();
  });
});

describe('MeteoraDecoder', () => {
  const d = new MeteoraDecoder();

  it('fires on the initializeLbPair discriminator', () => {
    const accounts = [VALID_POOL, VALID_A, VALID_B, VALID_A, VALID_A, VALID_B, VALID_C, VALID_A, VALID_B, VALID_C, VALID_A];
    const data = Buffer.concat([
      Buffer.from([69, 26, 125, 119, 23, 222, 236, 175]),
      Buffer.alloc(16),
    ]);
    const event = d.decode({ programId: d.programIds[0], accounts, data }, ctx);
    expect(event).not.toBeNull();
    expect(event!.dex).toBe('meteora');
  });

  it('returns null for wrong discriminator', () => {
    const ix = { programId: d.programIds[0], accounts: Array(11).fill(VALID_A), data: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]) };
    expect(d.decode(ix, ctx)).toBeNull();
  });
});

describe('OrcaDecoder', () => {
  const d = new OrcaDecoder();

  it('returns null for short data (likely a swap)', () => {
    const ix = { programId: d.programIds[0], accounts: Array(12).fill(VALID_A), data: Buffer.from([1, 2, 3]) };
    expect(d.decode(ix, ctx)).toBeNull();
  });

  it('fires when data is long enough and pool address is valid', () => {
    const accounts = Array(12).fill(VALID_A);
    accounts[1] = VALID_POOL;
    accounts[3] = VALID_B;
    accounts[4] = VALID_C;
    const data = Buffer.alloc(64);
    const event = d.decode({ programId: d.programIds[0], accounts, data }, ctx);
    expect(event).not.toBeNull();
    expect(event!.dex).toBe('orca');
  });
});

describe('DecoderRegistry', () => {
  it('registry exposes at least one program ID (PumpSwap active)', () => {
    const r = new DecoderRegistry();
    expect(r.programIds().length).toBeGreaterThanOrEqual(1);
    expect(r.programIds()).toContain('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  });

  it('returns null for unknown program IDs', () => {
    const r = new DecoderRegistry();
    const ix = { programId: 'unknown', accounts: [], data: Buffer.alloc(0) };
    expect(r.decode(ix, ctx)).toBeNull();
  });
});
