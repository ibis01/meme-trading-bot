import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../../utils/logger';

export interface WalletProfile {
  address: string;
  funder: string | null;
  firstSeenAt: number;
}

export class WalletRegistry {
  private cache = new Map<string, WalletProfile>();
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  async getProfile(walletAddress: string): Promise<WalletProfile> {
    const cached = this.cache.get(walletAddress);
    if (cached) return cached;

    let funder: string | null = null;
    try {
      const pubkey = new PublicKey(walletAddress);
      const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit: 1 });
      
            if (sigs.length > 0) {
              const tx = await this.connection.getTransaction(
                sigs[sigs.length - 1].signature,
                {
                  maxSupportedTransactionVersion: 0,
                },
              );
              if (tx?.transaction.message.staticAccountKeys) {
                // <-- Changed here
                const otherKey = tx.transaction.message.staticAccountKeys.find(
                  (pubkey: PublicKey) => pubkey.toBase58() !== walletAddress, // <-- Changed here
                );
                if (otherKey) funder = otherKey.toBase58(); // <-- Changed here
              }
            }
    } catch (err) {
      logger.warn({ walletAddress, err }, 'Failed to fetch wallet history for funder detection');
    }

    const profile: WalletProfile = { address: walletAddress, funder, firstSeenAt: Date.now() };
    this.cache.set(walletAddress, profile);
    return profile;
  }
}
