import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Parses the trading wallet key from config. Accepts base58 (Phantom-style
 * export) or a JSON byte array. Rule 12: the raw key must never appear in
 * logs; this function throws (never logs its input) on invalid keys.
 *
 * Lives in src/infra (not src/execution/live) so configuration validation
 * can bind the signing key to EXPECTED_WALLET_PUBKEY without importing the
 * execution layer (which imports config — an import cycle).
 */
export function parseWalletKey(raw: string): Keypair {
  let secret: Uint8Array;
  if (raw.trimStart().startsWith('[')) {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'number')) {
      throw new Error('WALLET_PRIVATE_KEY_INVALID_JSON_ARRAY');
    }
    secret = new Uint8Array(arr as number[]);
  } else {
    secret = bs58.decode(raw.trim());
  }
  if (secret.length !== 64) {
    throw new Error('WALLET_PRIVATE_KEY_INVALID_LENGTH');
  }
  return Keypair.fromSecretKey(secret);
}
