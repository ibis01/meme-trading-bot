import bs58 from 'bs58';
import { DecoderRegistry } from './decoders';
import { DecoderContext, RawInstruction } from './decoders/types';
import { PoolEvent } from './types';

/**
 * Parses a Solana transaction (as returned by Helius `transactionSubscribe`
 * notifications) and returns the first pool-creation event, if any.
 *
 * VERIFY (Rule 30): the transaction shape below follows the standard
 * `jsonParsed` / `json` RPC encoding. Confirm against Helius docs.
 */
export function parseTransaction(
  registry: DecoderRegistry,
  result: {
    signature?: string;
    slot?: number;
    transaction?: {
      meta?: { blockTime?: number };
      transaction?: { message?: { accountKeys?: unknown[]; instructions?: unknown[] } };
    };
  },
): PoolEvent | null {
  const signature = String(result.signature ?? '');
  const slot = Number(result.slot ?? 0);
  const blockTime = Number(result.transaction?.meta?.blockTime ?? 0);
  const blockTimeMs = blockTime > 0 ? blockTime * 1000 : Date.now();

  const message = result.transaction?.transaction?.message;
  if (!message) return null;

  // We also need inner instructions — Pump.fun creation happens inside a CPI.
  const innerGroups = (result.transaction?.meta as { innerInstructions?: Array<{ index?: number; instructions?: unknown[] }> } | undefined)?.innerInstructions ?? [];

  const accountKeysRaw = message.accountKeys ?? [];
  const accountKeys = accountKeysRaw.map(extractKey);
  const instructionsRaw = message.instructions ?? [];

  const ctx: DecoderContext = { signature, slot, blockTimeMs, allAccountKeys: accountKeys };

  // Pass 1: outer instructions
  for (const ixRaw of instructionsRaw) {
    const ix = normalizeInstruction(ixRaw, accountKeys);
    if (!ix) continue;
    const event = registry.decode(ix, ctx);
    if (event) return event;
  }

  // Pass 2: inner instructions (CPIs)
  for (const group of innerGroups) {
    for (const innerIxRaw of group.instructions ?? []) {
      const ix = normalizeInstruction(innerIxRaw, accountKeys);
      if (!ix) continue;
      const event = registry.decode(ix, ctx);
      if (event) return event;
    }
  }

  return null;
}

function extractKey(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && 'pubkey' in entry) {
    return String((entry as { pubkey: unknown }).pubkey);
  }
  return '';
}

function normalizeInstruction(
  entry: unknown,
  accountKeys: string[],
): RawInstruction | null {
  if (!entry || typeof entry !== 'object') return null;
  const ix = entry as Record<string, unknown>;

  // Program ID: in `json` encoding it's a pubkey string; in `jsonParsed` it's
  // resolved to the same field name. Fall back to accountKeys lookup for index.
  let programId = '';
  if (typeof ix.programId === 'string') programId = ix.programId;
  else if (typeof ix.programIdIndex === 'number') programId = accountKeys[ix.programIdIndex] ?? '';
  if (!programId) return null;

  // Accounts: array of indexes (json) or pubkeys (jsonParsed).
  const accounts: string[] = [];
  const rawAccounts = ix.accounts;
  if (Array.isArray(rawAccounts)) {
    for (const a of rawAccounts) {
      if (typeof a === 'number') accounts.push(accountKeys[a] ?? '');
      else if (typeof a === 'string') accounts.push(a);
    }
  }

  // Data: base58 string (json) or ignored (jsonParsed).
  let data = Buffer.alloc(0);
  if (typeof ix.data === 'string') {
    try { data = Buffer.from(bs58.decode(ix.data)); }
    catch { return null; }
  }

  return { programId, accounts, data };
}
