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
}
