import { PumpSwapDecoder } from '../src/data/poolEvents/decoders/pumpswap';

const VALID_POOL = 'So11111111111111111111111111111111111111112';
const VALID_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const VALID_B = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const VALID_C = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ctx = {
  signature: 'sig',
  slot: 1,
  blockTimeMs: 1_700_000_000_000,
  allAccountKeys: [VALID_A],
};

describe('PumpSwapDecoder (Task 050)', () => {
  const d = new PumpSwapDecoder();

  it('returns null on short instruction data', () => {
    const ix = { programId: d.programIds[0], accounts: [VALID_POOL], data: Buffer.from([0]) };
    expect(d.decode(ix, ctx)).toBeNull();
  });

  it('returns null on too few accounts', () => {
    const ix = { programId: d.programIds[0], accounts: [VALID_POOL], data: Buffer.alloc(64) };
    expect(d.decode(ix, ctx)).toBeNull();
  });

  it('extracts pool + mints + creator from a plausible create_pool', () => {
    const accounts = Array(10).fill(VALID_A);
    accounts[0] = VALID_POOL; // pool
    accounts[2] = VALID_A;    // creator
    accounts[3] = VALID_B;    // base_mint
    accounts[4] = VALID_C;    // quote_mint
    const data = Buffer.alloc(64);
    const event = d.decode({ programId: d.programIds[0], accounts, data }, ctx);
    expect(event).not.toBeNull();
    expect(event!.dex).toBe('pumpswap');
    expect(event!.poolAddress).toBe(VALID_POOL);
    expect(event!.baseMint).toBe(VALID_B);
    expect(event!.quoteMint).toBe(VALID_C);
    expect(event!.creatorWallet).toBe(VALID_A);
  });

  it('returns null if pool address is not a pubkey', () => {
    const accounts = Array(10).fill(VALID_A);
    accounts[0] = 'not-a-pubkey';
    const event = d.decode({ programId: d.programIds[0], accounts, data: Buffer.alloc(64) }, ctx);
    expect(event).toBeNull();
  });

  it('is registered with the correct program ID', () => {
    expect(d.programIds).toContain('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  });
});
