import { PoolEvent } from '../types';
import { DecoderContext, InstructionDecoder, RawInstruction } from './types';
import { isLikelyPubkey } from './raydium';

/**
 * VERIFY (Rule 30): pump.fun token creation (BondingCurveV3).
 *   Program:  6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   Discriminator (first 8 bytes of ix data): c2ab1c46684d5b2f
 *   Data length: 24 bytes  (8-byte discriminator + 2× u64 args)
 *   Accounts:    27
 *
 * Account layout (BEST-EFFORT, verify against real capture):
 *   0: mint              — the new SPL token mint
 *   1: mint_authority    — PDA
 *   2: bonding_curve     — PDA (pool address)
 *   3: associated_bonding_curve — ATA of bonding curve
 *   4: global            — program global state
 *   ...
 *   7: user (creator)    — VERIFY index
 */
const DISCRIMINATOR = Buffer.from([0xc2, 0xab, 0x1c, 0x46, 0x68, 0x4d, 0x5b, 0x2f]);
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class PumpFunCreateDecoder implements InstructionDecoder {
  readonly name = 'pumpfun';
  readonly programIds = [
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  ];

  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null {
    if (ix.data.length < 8) return null;
    if (!ix.data.subarray(0, 8).equals(DISCRIMINATOR)) return null;
    if (ix.accounts.length < 27) return null;

    const baseMint = ix.accounts[0];
    const poolAddress = ix.accounts[2];
    const creatorWallet = ix.accounts[7];

    if (!isLikelyPubkey(baseMint) || !isLikelyPubkey(poolAddress) || !isLikelyPubkey(creatorWallet)) {
      return null;
    }

    return {
      kind: 'POOL_CREATED',
      dex: 'pumpfun',
      poolAddress,
      baseMint,
      quoteMint: SOL_MINT,
      creatorWallet,
      signature: ctx.signature,
      slot: ctx.slot,
      blockTimeMs: ctx.blockTimeMs,
    };
  }
}
