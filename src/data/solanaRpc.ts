import { logger } from '../utils/logger';

export interface RpcResponse<T> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Minimal JSON-RPC client. Only the methods we need. No extra deps.
 * VERIFY (Rule 30): Solana RPC method signatures are stable but
 * occasionally add params. Confirm against docs.solana.com.
 */
export class SolanaRpcClient {
  private nextId = 1;

  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getTransaction(
    signature: string,
    opts: {
      encoding?: 'json' | 'jsonParsed' | 'base58' | 'base64';
      commitment?: 'processed' | 'confirmed' | 'finalized';
      maxSupportedTransactionVersion?: number;
    } = {},
  ): Promise<unknown | null> {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'getTransaction',
      params: [
        signature,
        {
          encoding: opts.encoding ?? 'jsonParsed',
          commitment: opts.commitment ?? 'confirmed',
          maxSupportedTransactionVersion: opts.maxSupportedTransactionVersion ?? 0,
        },
      ],
    };
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.warn(
          { event: 'RPC_HTTP_ERROR', status: res.status, method: 'getTransaction', signature },
          'RPC HTTP error',
        );
        return null;
      }
      const json = (await res.json()) as RpcResponse<unknown>;
      if (json.error) {
        logger.warn(
          { event: 'RPC_ERROR', method: 'getTransaction', error: json.error, signature },
          'RPC returned error',
        );
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      logger.error({ event: 'RPC_FETCH_ERROR', method: 'getTransaction', err }, 'RPC fetch threw');
      return null;
    }
  }

  async getLatestBlockhash(): Promise<string | null> {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'getLatestBlockhash',
      params: [],
    };
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as RpcResponse<{ value?: { blockhash?: string } }>;
      return json.result?.value?.blockhash ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Simulates a signed, serialized transaction. Returns the simulation error
   * (null when the simulation succeeded) plus logs. Rule 11: SIMULATE is a
   * mandatory stage before SUBMIT.
   */
  async simulateTransaction(
    signedTxB64: string,
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
  ): Promise<{ err: unknown; logs: string[] } | null> {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'simulateTransaction',
      params: [
        signedTxB64,
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment },
      ],
    };
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.warn({ event: 'RPC_HTTP_ERROR', status: res.status, method: 'simulateTransaction' }, 'RPC HTTP error');
        return null;
      }
      const json = (await res.json()) as RpcResponse<{ value?: { err?: unknown; logs?: string[] } }>;
      if (json.error) {
        logger.warn({ event: 'RPC_ERROR', method: 'simulateTransaction', error: json.error }, 'RPC returned error');
        return null;
      }
      return {
        err: json.result?.value?.err ?? null,
        logs: json.result?.value?.logs ?? [],
      };
    } catch (err) {
      logger.error({ event: 'RPC_FETCH_ERROR', method: 'simulateTransaction', err }, 'RPC fetch threw');
      return null;
    }
  }

  /**
   * Submits a signed, serialized transaction. Returns the signature on
   * success, null on RPC error. Network-level throw is rethrown so the
   * caller can distinguish "RPC said no" (definitive) from "did not reach
   * the network" (ambiguous → UNKNOWN per Rule 24).
   */
  async sendTransaction(
    signedTxB64: string,
    opts: { skipPreflight?: boolean; maxRetries?: number } = {},
  ): Promise<string | null> {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'sendTransaction',
      params: [
        signedTxB64,
        {
          encoding: 'base64',
          skipPreflight: opts.skipPreflight ?? true,
          maxRetries: opts.maxRetries ?? 0,
          preflightCommitment: 'confirmed',
        },
      ],
    };
    const res = await this.fetchImpl(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.warn({ event: 'RPC_HTTP_ERROR', status: res.status, method: 'sendTransaction' }, 'RPC HTTP error');
      return null;
    }
    const json = (await res.json()) as RpcResponse<string>;
    if (json.error) {
      logger.warn({ event: 'RPC_ERROR', method: 'sendTransaction', error: json.error }, 'RPC returned error');
      return null;
    }
    return typeof json.result === 'string' ? json.result : null;
  }

  /**
   * Signature statuses. A slot can be missing (null entry) — the caller must
   * treat null entries as "not yet seen", never as failure. The RPC method
   * returns all commitment levels; the caller ranks them.
   */
  async getSignatureStatuses(
    signatures: string[],
  ): Promise<Array<{ confirmationStatus: string | null; err: unknown } | null> | null> {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'getSignatureStatuses',
      params: [signatures, { searchHistory: true }],
    };
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as RpcResponse<{ value?: Array<Record<string, unknown> | null> }>;
      if (json.error) return null;
      const value = json.result?.value;
      if (!Array.isArray(value)) return null;
      return value.map((v) =>
        v == null
          ? null
          : {
              confirmationStatus: (v.confirmationStatus as string | undefined) ?? null,
              err: v.err ?? null,
            },
      );
    } catch (err) {
      logger.error({ event: 'RPC_FETCH_ERROR', method: 'getSignatureStatuses', err }, 'RPC fetch threw');
      return null;
    }
  }

  /** Token mint decimals (needed to convert human token units ↔ raw units). */
  async getTokenSupply(
    tokenMint: string,
  ): Promise<{ decimals: number } | null> {
    const body = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'getTokenSupply',
      params: [tokenMint],
    };
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as RpcResponse<{ value?: { decimals?: number } }>;
      if (json.error) return null;
      const decimals = json.result?.value?.decimals;
      return typeof decimals === 'number' ? { decimals } : null;
    } catch {
      return null;
    }
  }
}
