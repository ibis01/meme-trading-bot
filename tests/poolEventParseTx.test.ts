import { DecoderRegistry, RaydiumDecoder } from '../src/data/poolEvents/decoders';
import { parseTransaction } from '../src/data/poolEvents/parseTx';

describe('parseTransaction', () => {
  const VALID_A = 'So11111111111111111111111111111111111111112';
  const VALID_B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const VALID_C = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
  const VALID_POOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('returns null when no instructions are present', () => {
    const r = new DecoderRegistry();
    expect(parseTransaction(r, { signature: 'x', slot: 1 })).toBeNull();
  });

  it('decodes a Raydium initialize2 tx with numeric account indexes', () => {
    // 20 accounts; indexes 4, 8, 9, 17 matter for Raydium.
    const accounts = Array(20).fill(VALID_A);
    accounts[4] = VALID_POOL;
    accounts[8] = VALID_B;
    accounts[9] = VALID_C;
    accounts[17] = VALID_A;

    // Raydium AMM v4 program ID; we set it as an entry in accountKeys and reference by index.
    const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
    const accountKeys = [...accounts, RAYDIUM];
    const programIdIndex = accountKeys.length - 1;

    // Data: [1] as base58 = '5' (since base58 of single byte 0x01 is '5')
    const ixData = Buffer.from([1]).toString('base64'); // we won't use base64; use base58
    // bs58 of [1] is "5"; we need the correct value.
    const bs58 = require('bs58').default ?? require('bs58');
    const ixDataB58 = bs58.encode(Buffer.from([1]));

    const result = {
      signature: 'sig1',
      slot: 100,
      transaction: {
        meta: { blockTime: 1_700_000_000 },
        transaction: {
          message: {
            accountKeys,
            instructions: [
              { programIdIndex, accounts: accounts.map((_, i) => i), data: ixDataB58 },
            ],
          },
        },
      },
    };

    const event = parseTransaction(new DecoderRegistry([new RaydiumDecoder()]), result);
    expect(event).not.toBeNull();
    expect(event!.dex).toBe('raydium');
    expect(event!.poolAddress).toBe(VALID_POOL);
    expect(event!.baseMint).toBe(VALID_B);
  });

  it('returns null when nothing matches', () => {
    const result = {
      signature: 'sig1',
      slot: 100,
      transaction: {
        meta: { blockTime: 1_700_000_000 },
        transaction: {
          message: {
            accountKeys: [VALID_A],
            instructions: [{ programIdIndex: 0, accounts: [0], data: '' }],
          },
        },
      },
    };
    expect(parseTransaction(new DecoderRegistry(), result)).toBeNull();
  });
});
