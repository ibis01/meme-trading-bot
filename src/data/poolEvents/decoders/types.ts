import { PoolEvent } from '../types';

/** A raw instruction, with program ID and accounts resolved to base58 strings. */
export interface RawInstruction {
  programId: string;
  accounts: string[];
  /** Instruction data decoded to bytes (excluding the program ID's discriminator if applicable). */
  data: Buffer;
}

export interface DecoderContext {
  signature: string;
  slot: number;
  blockTimeMs: number;
  /** Full account key list (needed for program-ID index resolution when upstream passes indexes). */
  allAccountKeys: string[];
}

export interface InstructionDecoder {
  /** Name for logging: 'raydium' | 'meteora' | 'orca'. */
  readonly name: string;
  /** Program IDs this decoder handles. */
  readonly programIds: string[];
  /**
   * Try to decode this instruction as a pool-creation event.
   * Returns null if the instruction is not a pool creation (e.g. it's a swap).
   */
  decode(ix: RawInstruction, ctx: DecoderContext): PoolEvent | null;
}
