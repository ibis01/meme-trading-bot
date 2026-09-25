import WebSocket from 'ws';
import { ALL_PROGRAM_IDS } from './dexPrograms';
import { DecoderRegistry } from './decoders';
import { parseTransaction } from './parseTx';
import { filterPoolInitLogs } from './logFilter';
import { RpcQueue } from './rpcQueue';
import { PoolEventHandler, PoolEventSource } from './types';
import { SolanaRpcClient } from '../solanaRpc';
import { logger } from '../../utils/logger';

export interface LogsSubscribeOptions {
  commitment?: 'processed' | 'confirmed' | 'finalized';
  maxReconnectAttempts?: number;
  fetchImpl?: typeof fetch;
  rpcConcurrency?: number;
  rpcMinSpacingMs?: number;
  verbose?: boolean;
  /**
   * Sample 1 in N matching notifications (default 20).
   * Free-tier RPCs cannot keep up with the full firehose; sampling lets us
   * observe the pipeline without saturating the RPC quota.
   * Set to 1 to process every match (requires a paid RPC tier).
   */
  sampleRate?: number;
}

export class LogsSubscribePoolSource implements PoolEventSource {
  readonly name = 'logs-subscribe-pool-events';
  private ws: WebSocket | null = null;
  private handlers: PoolEventHandler[] = [];
  private nextId = 1;
  private running = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelayMs = 30_000;
  private readonly registry = new DecoderRegistry();
  private readonly rpc: SolanaRpcClient;
  private readonly rpcQueue: RpcQueue<unknown>;
  private readonly seen = new Set<string>();
  private readonly seenCap = 10_000;
  private matchCounter = 0;

  private stats = {
    notifications: 0,
    matched: 0,
    sampledIn: 0,
    filteredIn: 0,
    filteredOut: 0,
    rpcErrors: 0,
    decoded: 0,
  };

  constructor(
    private readonly wsUrl: string,
    rpcUrl: string,
    private readonly opts: LogsSubscribeOptions = {},
  ) {
    this.rpc = new SolanaRpcClient(rpcUrl, opts.fetchImpl ?? fetch);
    this.rpcQueue = new RpcQueue<unknown>({
      concurrency: opts.rpcConcurrency ?? 1,
      minSpacingMs: opts.rpcMinSpacingMs ?? 750,
      maxQueueLength: 500,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  onEvent(handler: PoolEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  isRunning(): boolean {
    return this.running && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getStats() {
    return { ...this.stats, queueDepth: this.rpcQueue.size() };
  }

  private connect(): void {
    if (!this.running) return;
    logger.info({ event: 'LOGS_WS_CONNECTING' }, 'Connecting to Solana WS');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      logger.info({ event: 'LOGS_WS_OPEN' }, 'WS open');
      const reqs = this.buildSubscribeRequests();
      if (this.opts.verbose) {
        logger.info({ event: 'LOGS_SUBSCRIBE_REQS', count: reqs.length }, 'Sending subscribe requests');
      }
      for (const req of reqs) this.ws?.send(JSON.stringify(req));
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      this.handleMessage(parsed as Record<string, unknown>);
    });

    this.ws.on('error', (err) => {
      logger.warn({ event: 'LOGS_WS_ERROR', err: String(err) }, 'WS error');
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(
        { event: 'LOGS_WS_CLOSED', code, reason: reason.toString(), attempts: this.reconnectAttempts },
        'WS closed',
      );
      this.ws = null;
      if (!this.running) return;
      const max = this.opts.maxReconnectAttempts ?? 10;
      if (this.reconnectAttempts >= max) {
        logger.error({ event: 'LOGS_WS_GIVEUP', attempts: this.reconnectAttempts }, 'Max reconnects reached');
        this.running = false;
        return;
      }
      this.reconnectAttempts += 1;
      const delay = Math.min(this.maxReconnectDelayMs, 1000 * 2 ** (this.reconnectAttempts - 1));
      logger.info({ event: 'LOGS_WS_RECONNECT', delayMs: delay }, 'Reconnecting');
      setTimeout(() => this.connect(), delay);
    });
  }

  private buildSubscribeRequests(): Record<string, unknown>[] {
    const commitment = this.opts.commitment ?? 'confirmed';
    return ALL_PROGRAM_IDS.map((programId) => ({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'logsSubscribe',
      params: [{ mentions: [programId] }, { commitment }],
    }));
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;
    if (method !== 'logsNotification') {
      if (msg.error) {
        logger.error({ event: 'LOGS_WS_ERROR_MSG', error: msg.error }, 'Subscription error from server');
      }
      return;
    }

    const params = msg.params as {
      result?: { value?: { signature?: string; err?: unknown; logs?: string[] } };
    } | undefined;
    const value = params?.result?.value;
    if (!value) return;

    this.stats.notifications += 1;

    const signature = value.signature;
    if (!signature) return;
    if (value.err) return;
    if (this.seen.has(signature)) return;
    if (this.seen.size >= this.seenCap) this.seen.clear();
    this.seen.add(signature);

    const logs = Array.isArray(value.logs) ? value.logs : [];
    const filter = filterPoolInitLogs(logs);
    if (!filter.matched) {
      this.stats.filteredOut += 1;
      return;
    }

    this.matchCounter += 1;
    this.stats.matched += 1;
    const sampleRate = this.opts.sampleRate ?? 20;
    if (sampleRate > 1 && this.matchCounter % sampleRate !== 0) {
      return;
    }

    this.stats.sampledIn += 1;
    this.stats.filteredIn += 1;
    void this.rpcQueue.enqueue(() => this.fetchAndDecode(signature));
  }

  private async fetchAndDecode(signature: string): Promise<void> {
    const tx = await this.rpc.getTransaction(signature, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
    });
    if (!tx) {
      this.stats.rpcErrors += 1;
      return;
    }

    const result = tx as {
      slot?: number;
      blockTime?: number;
      transaction?: { message?: { accountKeys?: unknown[]; instructions?: unknown[] } };
      meta?: { blockTime?: number; innerInstructions?: Array<{ index?: number; instructions?: unknown[] }> };
    };

    const wrapped = {
      signature,
      slot: result.slot,
      transaction: {
        meta: { blockTime: result.meta?.blockTime ?? result.blockTime, innerInstructions: result.meta?.innerInstructions },
        transaction: { message: result.transaction?.message },
      },
    };

    const event = parseTransaction(this.registry, wrapped);
    if (!event) return;

    this.stats.decoded += 1;
    logger.info({ event: 'POOL_EVENT_DECODED', ...event }, 'Pool event decoded');

    for (const h of this.handlers) {
      Promise.resolve()
        .then(() => h(event))
        .catch((err) =>
          logger.error({ event: 'POOL_EVENT_HANDLER_ERROR', err }, 'Handler threw'),
        );
    }
  }
}
