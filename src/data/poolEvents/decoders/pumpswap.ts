import { PoolEvent } from '../types';
import { DecoderContext, InstructionDecoder, RawInstruction } from './types';
import { isLikelyPubkey } from './raydium';

/**
 * VERIFY (Rule 30): PumpSwap AMM `create_pool` — Anchor program.
 *   Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *
 * Anchor discriminator for `create_pool` is the first 8 bytes of
 * sha256("global:create_pool"). Best-effort placeholder below; the
 * real value needs to be confirmed against a live transaction via the
 * `--capture-pumpswap` sniff mode before this decoder is trusted.
 *
 * Instruction data layout:
 *   [0..8]   discriminator
 *   [8..16]  index (u64)
 *   [16..24] base_amount_in (u64)
 *   [24..32] quote_amount_in (u64)
 *
 * Account order (typical for PumpSwap create_pool, VERIFY):
 *   0: pool
 *   1: global_config
 *   2: creator
 *   3: base_mint
 *   4: quote_mint
 *   5: lp_mint
 *   6: user_base_token_account
 *   7: user_quote_token_account
 *   8: user_pool_token_account
 *   ...
 */
const CREATE_POOL_DISCRIMINATOR_PLACEHOLDER = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);

export class PumpSwapDecoder implements InstructionDecoder {
  readonly name = 'pumpswap';
  readonly programIds = [
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  ];

  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null {
    // VERIFY: real discriminator needs to be confirmed. For now we accept
    // any instruction whose data is at least 32 bytes and has a plausible
    // account layout, and let the sniff CLI validate against real txs.
    if (ix.data.length < 32) return null;
    if (ix.accounts.length < 5) return null;

    // Placeholder account indexes — VERIFY against real PumpSwap create_pool.
    const poolAddress = ix.accounts[0] ?? '';
    const creatorWallet = ix.accounts[2] ?? '';
    const baseMint = ix.accounts[3] ?? '';
    const quoteMint = ix.accounts[4] ?? '';

    if (!isLikelyPubkey(poolAddress)) return null;
    if (!isLikelyPubkey(baseMint)) return null;

    // Suppress unused variable warning for the placeholder.
    void CREATE_POOL_DISCRIMINATOR_PLACEHOLDER;

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
