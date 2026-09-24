import { PoolEvent } from '../types';
import { DecoderContext, InstructionDecoder, RawInstruction } from './types';
import { isLikelyPubkey } from './raydium';

/**
 * VERIFY (Rule 30): Orca Whirlpool `initializePool` — Anchor program.
 *   https://docs.orca.so/
 *
 * Anchor discriminator = first 8 bytes of sha256("global:initialize_pool").
 * We verify by length; the exact bytes are marked TODO since Orca has
 * two init variants (`initializePool` and `initializePoolV2`) that use
 * different discriminators.
 *
 * Account order varies by version. Best-effort extraction only.
 */
export class OrcaDecoder implements InstructionDecoder {
  readonly name = 'orca';
  readonly programIds = [
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Whirlpool
  ];

  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null {
    // Heuristic: Orca init instructions are 8-byte Anchor discriminator + ~100+ args.
    // This is intentionally permissive until we verify against real transactions.
    if (ix.data.length < 40) return null;
    // Avoid decoding swaps which also target the same program.
    // Swaps are usually much smaller (< 24 bytes of data).
    if (ix.accounts.length < 10) return null;

    const poolAddress = ix.accounts[1] ?? '';
    const baseMint = ix.accounts[3] ?? '';
    const quoteMint = ix.accounts[4] ?? '';
    const creatorWallet = ix.accounts[ix.accounts.length - 1] ?? '';

    if (!isLikelyPubkey(poolAddress)) return null;

    return {
      kind: 'POOL_CREATED',
      dex: 'orca',
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
