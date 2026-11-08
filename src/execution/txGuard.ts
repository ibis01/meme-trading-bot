import { PublicKey } from '@solana/web3.js';

/**
 * Swap transaction guard (audit 2026-11-08, finding #2 — CRITICAL).
 *
 * The transaction returned by Jupiter's /swap API is UNTRUSTED INPUT: before
 * the wallet signs it, every instruction is validated against a strict
 * whitelist. Anything unexpected → the trade fails CLOSED (FAILED pre-submit,
 * nothing signed, nothing sent).
 *
 * What a legit Jupiter v6 swap with wrapAndUnwrapSol=true contains, and
 * NOTHING else:
 *   1. Compute Budget instructions (unit limit / priority price).
 *   2. Associated Token Program create/createIdempotent — ONLY with this
 *      wallet as owner AND funder (wSOL wrap + output-ATA convenience).
 *   3. Token Program closeAccount — ONLY on the wallet's WRAPPED-SOL token
 *      account created/ensured earlier in THIS transaction (the standard
 *      unwrap), lamports ONLY back to this wallet.
 *   4. Jupiter v6 program instructions (opaque routing — CPIs inside them are
 *      sandboxed to the programs the route calls, never our authority).
 *
 * Deliberately NOT permitted, and how a forgery is caught:
 *   - ANY System Program instruction → System createAccount requires the new
 *     account itself to sign (it is a required signer by protocol). A Jupiter
 *     /swap response can never carry such a signature, and we refuse ANY
 *     transaction with more than one required signer — so a "temp wSOL
 *     account" pattern is structurally impossible and System transfer/assign
 *     (a direct SOL drain) is refused outright.
 *   - Foreign required signer → a third party could authorize our funds.
 *   - Fee payer ≠ wallet → an unwitting payer for someone else's tx.
 *   - Any program outside the whitelist → arbitrary logic with our signature.
 *   - closeAccount on a pre-existing account (e.g. our USDC ATA) → its token
 *     balance would be burned. Only the in-transaction wSOL account may be
 *     closed, and only back to the wallet.
 *   - ATA create with a foreign owner/funder → our rent funding someone
 *     else's account, or setting up an account we do not control.
 */

export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC9PHuBCH6SsRFEH';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const LOOKUP_TABLE_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111';

/** The canonical wrapped-SOL mint — the ONLY token account Jupiter may close. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const PERMITTED_PROGRAMS = new Set([
  JUPITER_V6_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  ATA_PROGRAM_ID,
]);

/** 165-byte SPL token account, rent-exempt minimum in lamports (fixtures/ops). */
export const RENT_EXEMPT_TOKEN_ACCOUNT_LAMPORTS = 2_039_280;

// Instruction discriminators we accept (and nothing else).
const TOKEN_IXN_CLOSE_ACCOUNT = 9;
const ATA_IXN_CREATE = 0;
const ATA_IXN_CREATE_IDEMPOTENT = 1;

/** Instruction limit — a legit Jupiter route stays far below this. */
const MAX_INSTRUCTIONS = 24;

export interface SwapInstruction {
  /** Resolved program id (base58) — must be in the whitelist. */
  programId: string;
  /** Indexes into the FULL resolved account key list. */
  accounts: number[];
  /** Raw instruction data. */
  data: Uint8Array;
}

export interface SwapTxShape {
  /** Fee payer + sole permitted signer (base58). */
  walletAddress: string;
  /** FULL account key list (static + ALT-loaded), base58. */
  keys: string[];
  numRequiredSignatures: number;
  instructions: SwapInstruction[];
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function validateSwapTxShape(tx: SwapTxShape): GuardResult {
  // ── Signers & fee payer ────────────────────────────────────────────────
  if (tx.numRequiredSignatures !== 1) {
    return {
      ok: false,
      reason: `MULTIPLE_REQUIRED_SIGNERS:${tx.numRequiredSignatures}`,
    };
  }
  if (tx.keys.length === 0) return { ok: false, reason: 'NO_ACCOUNT_KEYS' };
  if (tx.keys[0] !== tx.walletAddress) {
    return { ok: false, reason: `FEE_PAYER_NOT_WALLET:${tx.keys[0]}` };
  }
  // numRequiredSignatures === 1 AND keys[0] === wallet ⇒ the ONLY required
  // signer is the wallet.

  // ── Instruction inventory ──────────────────────────────────────────────
  if (tx.instructions.length < 2) {
    return { ok: false, reason: 'INSUFFICIENT_INSTRUCTIONS' };
  }
  if (tx.instructions.length > MAX_INSTRUCTIONS) {
    return { ok: false, reason: `TOO_MANY_INSTRUCTIONS:${tx.instructions.length}` };
  }

  let jupiterCount = 0;
  /** Accounts freshly created by a plain ATA create (closeable). */
  const freshAccounts = new Set<number>();
  /** Accounts ensured by an ATA create, with their mint (base58). */
  const ataMintById = new Map<number, string>();

  for (let i = 0; i < tx.instructions.length; i++) {
    const ixn = tx.instructions[i];

    // Program whitelist + index sanity (fail closed on any aliasing bug).
    if (!PERMITTED_PROGRAMS.has(ixn.programId)) {
      return { ok: false, reason: `PROGRAM_NOT_PERMITTED:${ixn.programId}` };
    }
    for (const idx of ixn.accounts) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= tx.keys.length) {
        return { ok: false, reason: `ACCOUNT_INDEX_OUT_OF_BOUNDS:${i}:${idx}` };
      }
    }

    switch (ixn.programId) {
      case SYSTEM_PROGRAM_ID:
        // createAccount needs the new account's own signature (forbidden by
        // the header check); transfer/assign would move SOL directly.
        return { ok: false, reason: `SYSTEM_INSTRUCTION_NOT_PERMITTED:${discLabel(ixn)}` };
      case ATA_PROGRAM_ID: {
        const r = validateAtaIxn(ixn, tx, freshAccounts, ataMintById);
        if (!r.ok) return r;
        break;
      }
      case TOKEN_PROGRAM_ID:
      case TOKEN_2022_PROGRAM_ID: {
        const r = validateTokenIxn(ixn, tx, freshAccounts, ataMintById);
        if (!r.ok) return r;
        break;
      }
      case COMPUTE_BUDGET_PROGRAM_ID:
        break; // unit limit / priority price — harmless by construction
      case JUPITER_V6_PROGRAM_ID:
        jupiterCount += 1;
        break; // opaque routing; CPI sandboxing is the aggregator's contract
      default:
        return { ok: false, reason: `PROGRAM_NOT_PERMITTED:${ixn.programId}` };
    }
  }

  if (jupiterCount === 0) {
    return { ok: false, reason: 'NO_JUPITER_INSTRUCTION' };
  }
  return { ok: true };
}

function validateAtaIxn(
  ixn: SwapInstruction,
  tx: SwapTxShape,
  freshAccounts: Set<number>,
  ataMintById: Map<number, string>,
): GuardResult {
  // create / createIdempotent: accounts = [funding, ata, owner, mint, …].
  if (ixn.data.length < 1 || (ixn.data[0] !== ATA_IXN_CREATE && ixn.data[0] !== ATA_IXN_CREATE_IDEMPOTENT)) {
    return { ok: false, reason: `ATA_INSTRUCTION_NOT_PERMITTED:${discLabel(ixn)}` };
  }
  if (ixn.accounts.length < 4) {
    return { ok: false, reason: 'ATA_INSTRUCTION_MALFORMED' };
  }
  const funder = tx.keys[ixn.accounts[0]];
  const owner = tx.keys[ixn.accounts[2]];
  const mint = tx.keys[ixn.accounts[3]];
  if (owner !== tx.walletAddress) {
    return { ok: false, reason: `ATA_OWNER_NOT_WALLET:${owner}` };
  }
  if (funder !== tx.walletAddress) {
    return { ok: false, reason: `ATA_FUNDER_NOT_WALLET:${funder}` };
  }
  const ataIdx = ixn.accounts[1];
  if (ixn.data[0] === ATA_IXN_CREATE) {
    // Plain create of a fresh PDA — safe to close later (rent recovery).
    freshAccounts.add(ataIdx);
  }
  // Idempotent may target a PRE-EXISTING account — record the mint so the
  // closeAccount rule can allow ONLY the wrapped-SOL account.
  ataMintById.set(ataIdx, mint);
  return { ok: true };
}

function validateTokenIxn(
  ixn: SwapInstruction,
  tx: SwapTxShape,
  freshAccounts: Set<number>,
  ataMintById: Map<number, string>,
): GuardResult {
  if (ixn.data.length < 1) return { ok: false, reason: 'TOKEN_INSTRUCTION_MALFORMED' };
  const disc = ixn.data[0];
  if (disc !== TOKEN_IXN_CLOSE_ACCOUNT) {
    // Transfers/approvals/mints/re-initializations have no place in a swap.
    return { ok: false, reason: `TOKEN_INSTRUCTION_NOT_PERMITTED:${disc}` };
  }
  // closeAccount: [9]; accounts = [account, destination, authority].
  if (ixn.accounts.length < 2) {
    return { ok: false, reason: 'TOKEN_INSTRUCTION_MALFORMED' };
  }
  const target = ixn.accounts[0];
  const closeable =
    freshAccounts.has(target) || ataMintById.get(target) === WSOL_MINT;
  if (!closeable) {
    // Not created in this tx (or not the wSOL account) — closing it would
    // burn a pre-existing balance.
    return { ok: false, reason: 'TOKEN_CLOSE_TARGET_NOT_CREATED' };
  }
  const destination = tx.keys[ixn.accounts[1]];
  if (destination !== tx.walletAddress) {
    return { ok: false, reason: `TOKEN_CLOSE_DEST_NOT_WALLET:${destination}` };
  }
  return { ok: true };
}

// ── helpers ───────────────────────────────────────────────────────────────

function base58Of(data: Uint8Array, start: number, end: number): string {
  return new PublicKey(data.slice(start, end)).toBase58();
}

function discLabel(ixn: SwapInstruction): string {
  return ixn.data.length > 0 ? String(ixn.data[0]) : 'EMPTY';
}

// base58Of is retained for future instruction-level checks that need to read
// embedded pubkeys (e.g. tightening per-instruction payloads).
void base58Of;
