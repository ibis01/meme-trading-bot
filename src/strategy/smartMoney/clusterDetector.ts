import { logger } from '../../utils/logger';
import { WalletRegistry } from './walletRegistry';
import { Signal } from '../types';
import { randomUUID } from 'crypto';

export interface BuyEvent {
  wallet: string;
  time: number;
  solAmount: number;
  funder: string | null;
}

export class ClusterDetector {
  private recentBuys = new Map<string, BuyEvent[]>();
  private readonly windowMs = 300_000;
  private readonly minWallets = 5;
  private readonly minFunders = 3;

  constructor(private walletRegistry: WalletRegistry) {}

  async processSwap(mint: string, wallet: string, solAmount: number): Promise<Signal | null> {
    const profile = await this.walletRegistry.getProfile(wallet);
    const now = Date.now();
    const bucket = this.recentBuys.get(mint) ?? [];
    bucket.push({ wallet, time: now, solAmount, funder: profile.funder });

    const validBuys = bucket.filter(b => now - b.time < this.windowMs);
    this.recentBuys.set(mint, validBuys);

    const uniqueWallets = new Set(validBuys.map(b => b.wallet)).size;
    const uniqueFunders = new Set(validBuys.map(b => b.funder).filter(Boolean)).size;
    const totalSol = validBuys.reduce((sum, b) => sum + b.solAmount, 0);

    if (uniqueWallets >= this.minWallets && uniqueFunders >= this.minFunders) {
      logger.info({ mint, uniqueWallets, uniqueFunders, totalSol }, 'CLUSTER_DETECTED');
      return {
        id: randomUUID(),
        tokenMint: mint,
        strategy: 'SMART_MONEY_CLUSTER_V1',
        strategyVersion: '1.0.0',
        createdAt: now,
        side: 'BUY',
        score: uniqueWallets,
        proposedAmountSol: 0.05,
        proposedSlippageBps: 150, 
        proposedPriceImpactBps: 200,
        isShadow: true,
        evidence: {
          indicators: { uniqueWallets, uniqueFunders, totalSol },
          entryReason: 'Shadow cluster detection',
        },
      };
    }
    return null;
  }
}
