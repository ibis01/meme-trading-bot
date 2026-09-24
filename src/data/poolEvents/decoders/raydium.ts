import { PoolEvent } from '../types';
import { DecoderContext, InstructionDecoder, RawInstruction } from './types';

/**
 * VERIFY (Rule 30): Raydium AMM v4 `initialize2` instruction layout.
 *   https://github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs
 *
 * Instruction data (26 bytes):
 *   [0]      u8   discriminant = 1
 *   [1]      u8   nonce
 *   [2..10]  u64  open_time (LE)
 *   [10..18] u64  init_pc_amount (LE)
 *   [18..26] u64  init_coin_amount (LE)
 *
 * Account order (as of writing):
 *   4:  amm (pool address)          ← we want this
 *   8:  coin_mint (base)            ← we want this
 *   9:  pc_mint (quote)             ← we want this
 *   17: user_wallet (creator)       ← we want this
 *
 * If Raydium changes the layout, this decoder will produce wrong fields.
 * Task 045's `sniff` CLI is designed to catch that against real transactions.
 */
export class RaydiumDecoder implements InstructionDecoder {
  readonly name = 'raydium';
  readonly programIds = [
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // AMM v4
  ];

  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null {
    // Discriminator 1 = initialize2
    if (ix.data.length < 1 || ix.data[0] !== 1) return null;
    if (ix.accounts.length < 18) return null;

    const poolAddress = ix.accounts[4];
    const baseMint = ix.accounts[8];
    const quoteMint = ix.accounts[9];
    const creatorWallet = ix.accounts[17];

    if (!poolAddress || !baseMint || !quoteMint || !creatorWallet) return null;

    // Sanity: pool/base/quote should look like pubkeys (43-44 base58 chars).
    if (!isLikelyPubkey(poolAddress)) return null;
    if (!isLikelyPubkey(baseMint)) return null;
    if (!isLikelyPubkey(quoteMint)) return null;

    return {
      kind: 'POOL_CREATED',
      dex: 'raydium',
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

export function isLikelyPubkey(s: string): boolean {
  return typeof s === 'string' && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
