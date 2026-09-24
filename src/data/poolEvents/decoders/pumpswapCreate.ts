import { PoolEvent } from '../types';
import { DecoderContext, InstructionDecoder, RawInstruction } from './types';
import { isLikelyPubkey } from './raydium';

/**
 * VERIFY (Rule 30): PumpSwap pool creation (InitiateTheChaos).
 *   Emitted by: brrnmzmsmY8cEqYRyaTr7C3JHfWmkYYyzz9RR8Km9X3  (wrapper)
 *   Related to: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA  (AMM)
 *   Discriminator: 51bb12da9fd2ffb4
 *   Data length:   80 bytes  (8-byte disc + 72 bytes of args)
 *   Accounts:      28
 *
 * Account layout (BEST-EFFORT, verify against real capture):
 *   0: pool            — the new pool address (VERIFY)
 *   2: creator/payer   — VERIFY
 *   3: base_mint       — VERIFY
 *   4: quote_mint      — VERIFY
 */
const DISCRIMINATOR = Buffer.from([0x51, 0xbb, 0x12, 0xda, 0x9f, 0xd2, 0xff, 0xb4]);

export class PumpSwapCreateDecoder implements InstructionDecoder {
  readonly name = 'pumpswap';
  readonly programIds = [
    'brrnmzmsmY8cEqYRyaTr7C3JHfWmkYYyzz9RR8Km9X3',
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  ];

  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null {
    if (ix.data.length < 8) return null;
    if (!ix.data.subarray(0, 8).equals(DISCRIMINATOR)) return null;
    if (ix.accounts.length < 5) return null;

    const poolAddress = ix.accounts[0];
    const creatorWallet = ix.accounts[2];
    const baseMint = ix.accounts[3];
    const quoteMint = ix.accounts[4];

    if (!isLikelyPubkey(poolAddress) || !isLikelyPubkey(baseMint) || !isLikelyPubkey(quoteMint)) {
      return null;
    }

    return {
      kind: 'POOL_CREATED',
      dex: 'pumpswap',
      poolAddress,
      baseMint,
      quoteMint,
      creatorWallet,
      signature: ctx.signature,
      slot: ctx.slot,
      blockTimeMs: ctx.blockTimeMs,
    };
  }
}
