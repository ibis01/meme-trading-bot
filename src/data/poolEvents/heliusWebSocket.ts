import WebSocket from 'ws';
import { PoolEvent, PoolEventHandler, PoolEventSource } from './types';
import { ALL_PROGRAM_IDS } from './dexPrograms';
import { DecoderRegistry } from './decoders';
import { parseTransaction } from './parseTx';
import { logger } from '../../utils/logger';

/**
 * VERIFY (Rule 30): Helius `transactionSubscribe` params and notification shape.
 *   https://docs.helius.dev/webhooks-and-websockets/websocket-subscriptions
 * Adjust `buildSubscribeRequest` and `parseTransaction` if the format has changed.
 *
 * At this stage we only detect that a pool-creation program was touched.
 * Full instruction decoding (initialize2, initializeLbPair, etc.) lands in Task 045.
 */
export class HeliusWebSocketPoolSource implements PoolEventSource {
  readonly name = 'helius-pool-events';
  private ws: WebSocket | null = null;
  private handlers: PoolEventHandler[] = [];
  private nextId = 1;
  private running = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelayMs = 30_000;
  private readonly registry = new DecoderRegistry();

  constructor(
    private readonly wsUrl: string,
    private readonly opts: {
      commitment?: 'processed' | 'confirmed' | 'finalized';
      maxReconnectAttempts?: number;
    } = {},
  ) {}

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

  private connect(): void {
    if (!this.running) return;
    logger.info({ event: 'WS_CONNECTING', url: redactWsUrl(this.wsUrl) }, 'Connecting to Helius WebSocket');
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      logger.info({ event: 'WS_OPEN' }, 'Helius WebSocket open');
      const req = this.buildSubscribeRequest();
      if (process.env.DEBUG_WS === '1') {
        logger.info({ event: 'WS_SUBSCRIBE_REQ', req }, 'Sending subscribe request');
      }
      this.ws?.send(JSON.stringify(req));
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      const text = raw.toString();
      if (process.env.DEBUG_WS === '1') {
        logger.info({ event: 'WS_RAW', bytes: text.length, preview: text.slice(0, 300) }, 'Raw WS message');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return; }
      this.handleMessage(parsed as Record<string, unknown>);
    });

    this.ws.on('error', (err) => {
      logger.warn({ event: 'WS_ERROR', err: String(err) }, 'Helius WebSocket error');
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(
        { event: 'WS_CLOSED', code, reason: reason.toString(), attempts: this.reconnectAttempts },
        'Helius WebSocket closed',
      );
      this.ws = null;
      if (!this.running) return;
      const max = this.opts.maxReconnectAttempts ?? 10;
      if (this.reconnectAttempts >= max) {
        logger.error({ event: 'WS_GIVEUP', attempts: this.reconnectAttempts }, 'Max reconnects reached');
        this.running = false;
        return;
      }
      this.reconnectAttempts += 1;
      const delay = Math.min(this.maxReconnectDelayMs, 1000 * 2 ** (this.reconnectAttempts - 1));
      logger.info({ event: 'WS_RECONNECT', delayMs: delay }, 'Reconnecting');
      setTimeout(() => this.connect(), delay);
    });
  }

  private buildSubscribeRequest(): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'transactionSubscribe',
      params: [
        {
          accountInclude: ALL_PROGRAM_IDS,
          failed: false,
        },
        {
          commitment: this.opts.commitment ?? 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Helius sends `{ method: "transactionNotification", params: { result: { transaction, signature, slot } } }`
    // Confirm the exact shape in docs before relying on it.
    const method = msg.method as string | undefined;
    if (method !== 'transactionNotification') {
      if (process.env.DEBUG_WS === '1') {
        logger.info({ event: 'WS_OTHER_METHOD', method, preview: JSON.stringify(msg).slice(0, 300) }, 'Non-notification message');
      }
      return;
    }

    const params = msg.params as { result?: Record<string, unknown> } | undefined;
    const result = params?.result;
    if (!result) return;

    const event = parseTransaction(this.registry, result);
    if (!event) return;

    for (const h of this.handlers) {
      Promise.resolve()
        .then(() => h(event))
        .catch((err) =>
          logger.error({ event: 'POOL_EVENT_HANDLER_ERROR', err }, 'Handler threw'),
        );
    }
  }

}

function redactWsUrl(url: string): string {
  return url.replace(/api-key=[^&]+/, 'api-key=<REDACTED>');
}
