export type DexName = 'raydium' | 'meteora' | 'orca' | 'pumpswap' | 'pumpfun';

export interface PoolEvent {
  kind: 'POOL_CREATED';
  dex: DexName;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  creatorWallet: string;
  signature: string;
  slot: number;
  blockTimeMs: number;
  /** Enriched after initial detection. Optional. */
  initialLiquidityUsd?: number;
  initialHolderCount?: number;
}

export type PoolEventHandler = (event: PoolEvent) => void | Promise<void>;

export interface PoolEventSource {
  readonly name: string;
  /** Begin receiving events. Idempotent — second call is a no-op. */
  start(): Promise<void>;
  /** Stop receiving events and release resources. */
  stop(): Promise<void>;
  /** Register a handler. Returns an unsubscribe function. */
  onEvent(handler: PoolEventHandler): () => void;
  isRunning(): boolean;
}
