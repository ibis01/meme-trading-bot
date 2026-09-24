import { paperRun } from './paperRun';
import { MarketSnapshot, StrategyContext } from '../strategy/types';

function fixture(): { market: MarketSnapshot; ctx: StrategyContext; prices: Record<string, number> } {
  const tokenMint = 'DEMO_TOKEN_MINT_11111111111111111111111111111';
  const market: MarketSnapshot = {
    tokenMint,
    fetchedAt: Date.now(),
    priceUsd: 0.001,
    liquidityUsd: 250_000,
    volume24hUsd: 1_200_000,
    holderCount: 3_200,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 8_500,
    priceChange5mPercent: 6.4,
    priceChange1hPercent: 14.1,
  };
  const ctx: StrategyContext = {
    equitySol: 10,
    riskPerTradeSol: 0.1,
    maxPositionSol: 0.1,
  };
  const prices = { [tokenMint]: 0.001 };
  return { market, ctx, prices };
}

async function main() {
  const { market, ctx, prices } = fixture();
  console.log('--- PAPER RUN START ---');
  const result = await paperRun({ market, ctx, prices });
  console.log('--- RESULT ---');
  console.log(JSON.stringify(
    {
      signalId: result.signal?.id,
      score: result.signal?.score,
      proposedAmountSol: result.signal?.proposedAmountSol,
      entryReason: result.signal?.evidence.entryReason,
      orchestratorKind: result.orchestratorKind,
      orchestratorReason: result.orchestratorReason,
      executionKind: result.executionKind,
      executionSignature: result.executionSignature,
      openPositionsAfter: result.openPositionsAfter,
    },
    null,
    2,
  ));
  console.log('--- PAPER RUN END ---');
}

main().catch((err) => {
  console.error('PAPER RUN FAILED', err);
  process.exit(1);
});
