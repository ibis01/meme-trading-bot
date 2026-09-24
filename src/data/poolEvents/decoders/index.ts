import { RaydiumDecoder } from './raydium';
import { MeteoraDecoder } from './meteora';
import { OrcaDecoder } from './orca';
import { PumpSwapDecoder } from './pumpswap';
import { PumpFunCreateDecoder } from './pumpfunCreate';
import { PumpSwapCreateDecoder } from './pumpswapCreate';
import { DecoderContext, InstructionDecoder, RawInstruction } from './types';
import { PoolEvent } from '../types';

export * from './types';
export {
  RaydiumDecoder,
  MeteoraDecoder,
  OrcaDecoder,
  PumpSwapDecoder,
  PumpFunCreateDecoder,
  PumpSwapCreateDecoder,
};

/**
 * Registry of ACTIVE decoders.
 *
 * Active:
 *  - PumpFunCreateDecoder  (verified discriminator c2ab1c46684d5b2f)
 *  - PumpSwapCreateDecoder (verified discriminator 51bb12da9fd2ffb4)
 *
 * Dormant (exported for tests only):
 *  - RaydiumDecoder, MeteoraDecoder, OrcaDecoder, PumpSwapDecoder
 */
export class DecoderRegistry {
  private readonly byProgram: Map<string, InstructionDecoder[]>;

  constructor(decoders: InstructionDecoder[] = [
    new PumpFunCreateDecoder(),
    new PumpSwapCreateDecoder(),
  ]) {
    this.byProgram = new Map();
    for (const d of decoders) {
      for (const pid of d.programIds) {
        const existing = this.byProgram.get(pid) ?? [];
        existing.push(d);
        this.byProgram.set(pid, existing);
      }
    }
  }

  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null {
    const candidates = this.byProgram.get(ix.programId);
    if (!candidates || candidates.length === 0) return null;
    for (const d of candidates) {
      const event = d.decode(ix, ctx);
      if (event) return event;
    }
    return null;
  }

  programIds(): string[] {
    return [...this.byProgram.keys()];
  }
}
