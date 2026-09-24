import { DexName } from './types';

/**
 * VERIFY (Rule 30): program IDs discovered via on-chain capture (Task 050–053).
 * If a program is redeployed, these IDs change and decoders silently stop firing.
 */
export const DEX_PROGRAMS: Record<string, DexName> = {
  // Pump.fun token creation (handled as inner instruction of 6Vo3245 wrapper)
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun',
  '6Vo3245eszAbCy8M1EyNfhBaGXnPPtEcyZhFbNwDscSz': 'pumpfun',

  // PumpSwap AMM (observed as outer instruction from brrnmzmsmY8c wrapper)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'pumpswap',
  'brrnmzmsmY8cEqYRyaTr7C3JHfWmkYYyzz9RR8Km9X3': 'pumpswap',

  // Raydium (kept for completeness; native program, no Instruction: logs)
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'raydium',

  // Meteora
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora',

  // Orca
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca',
};

export const ALL_PROGRAM_IDS: string[] = Object.keys(DEX_PROGRAMS);

export const PUMPFUN_MAIN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPFUN_WRAPPER_PROGRAM = '6Vo3245eszAbCy8M1EyNfhBaGXnPPtEcyZhFbNwDscSz';
export const PUMPSWAP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMPSWAP_WRAPPER_PROGRAM = 'brrnmzmsmY8cEqYRyaTr7C3JHfWmkYYyzz9RR8Km9X3';
