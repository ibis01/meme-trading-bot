import {
  SecurityProvider,
  TokenSecurityEvidence,
  unsafeEvidence,
} from './types';
import { logger } from '../utils/logger';

/**
 * VERIFY BEFORE LIVE USE (Rule 30):
 *   https://api.rugcheck.xyz/swagger/index.html
 * Field names below are best-effort. If any required field is missing,
 * this provider returns `unsafeEvidence()` so the risk engine rejects.
 */
export class RugCheckProvider implements SecurityProvider {
  readonly name = 'rugcheck';

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async check(tokenMint: string): Promise<TokenSecurityEvidence> {
    try {
      const url = `${this.baseUrl}/report/summary/${tokenMint}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`RugCheck HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;

      const mintAuthority = data.mintAuthority ?? data.mint_authority;
      const freezeAuthority = data.freezeAuthority ?? data.freeze_authority;
      const top10 = data.top10HoldersPercent ?? data.top10_holder_percent;
      const dev = data.creatorHoldersPercent ?? data.dev_wallet_percent;
      const liq = data.totalMarketLiquidity ?? data.liquidity_usd;
      const rugged = data.rugged;

      const top10Num = typeof top10 === 'number' ? top10 : Number(top10);
      const devNum = typeof dev === 'number' ? dev : Number(dev);
      const liqNum = typeof liq === 'number' ? liq : Number(liq);

      // Fail-closed on REQUIRED fields being ABSENT (audit fix H2).
      // `undefined` authority/rugged fields previously evaluated as
      // "authority disabled" / "sellability confirmed" via negation — a
      // silent fail-OPEN on the two most dangerous rug vectors. Null is a
      // meaningful value (no authority set); undefined means the API shape
      // changed and we must not guess.
      const hasAuthorityData =
        (data.mintAuthority !== undefined ||
          data.mint_authority !== undefined) &&
        (data.freezeAuthority !== undefined ||
          data.freeze_authority !== undefined) &&
        data.rugged !== undefined;
      if (
        !hasAuthorityData ||
        !Number.isFinite(top10Num) ||
        !Number.isFinite(devNum) ||
        !Number.isFinite(liqNum)
      ) {
        logger.warn(
          { event: 'SECURITY_DATA_INCOMPLETE', token: tokenMint },
          'RugCheck response missing required fields — failing closed',
        );
        return unsafeEvidence(tokenMint, 'rugcheck');
      }

      return {
        tokenMint,
        // null = no authority set = disabled. Any non-null value (pubkey)
        // means the authority is live. (?? null guards the camelCase-null
        // case: null is a meaningful value, not a fall-through.)
        mintAuthorityDisabled: (mintAuthority ?? null) === null,
        freezeAuthorityDisabled: (freezeAuthority ?? null) === null,
        top10HolderPercent: top10Num,
        devWalletPercent: devNum,
        liquidityUsd: liqNum,
        sellabilityConfirmed: rugged === false,
        fetchedAt: Date.now(),
        source: 'rugcheck',
      };
    } catch (err) {
      logger.error(
        { event: 'SECURITY_DATA_ERROR', token: tokenMint, err },
        'RugCheck fetch failed',
      );
      return unsafeEvidence(tokenMint, 'rugcheck');
    }
  }
}
