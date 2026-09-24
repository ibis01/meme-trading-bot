import { PoolEvent } from '../types';
import { DecoderContext, InstructionDecoder, RawInstruction } from './types';
import { isLikelyPubkey } from './raydium';

/**
 * VERIFY (Rule 30): Meteora DLMM `initializeLbPair` — Anchor program.
 *   https://docs.meteora.ag/integrations/dlmm-program
 *
 * Anchor discriminators are the first 8 bytes of sha256("global:<ix_name>").
 * For `initialize_lb_pair` the discriminator is:
 *   [69, 26, 125, 119, 23, 222, 236, 175]
 * The remaining bytes are Borsh-encoded args (we don't need them for detection).
 *
 * Account order (as of writing):
 *   LB pair is typically account 0 or 1 depending on the version.
 *   Token mints appear at positions 5 and 6.
 *   Creator is usually at the last position.
 *
 * Because Meteora has changed layout between versions, the decoder only
 * reports a minimal event with the fields it can extract confidently.
 * Task 045's `sniff` CLI will show what the real layout is.
 */
const INITIALIZE_LB_PAIR_DISCRIMINATOR = Buffer.from([69, 26, 125, 119, 23, 222, 236, 175]);

export class MeteoraDecoder implements InstructionDecoder {
  readonly name = 'meteora';
  readonly programIds = [
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // DLMM
  ];

  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null {
    if (ix.data.length < 8) return null;
    const disc = ix.data.subarray(0, 8);
    if (!disc.equals(INITIALIZE_LB_PAIR_DISCRIMINATOR)) return null;

    // Best-effort account resolution. VERIFY against real data.
    const poolAddress = ix.accounts[0] ?? '';
    const creatorWallet = ix.accounts[ix.accounts.length - 1] ?? '';
    const baseMint = ix.accounts[5] ?? '';
    const quoteMint = ix.accounts[6] ?? '';

    if (!isLikelyPubkey(poolAddress)) return null;

    return {
      kind: 'POOL_CREATED',
      dex: 'meteora',
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
