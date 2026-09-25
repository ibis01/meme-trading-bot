/**
 * P1 smoke test: one real Birdeye fetch, one real classification.
 *
 * Exit codes (chainable with &&):
 *   0  REAL       — non-null snapshot, price > 0, fetchedAt fresh
 *   1  INCOMPLETE — provider returned null (partial fields, Rule 30)
 *   2  BLOCKED    — fetch threw (quota, HTTP error, network)
 *   3  UNEXPECTED — anything else
 *
 * Usage:
 *   npm run smoke:birdeye                 # USDC
 *   npm run smoke:birdeye -- <mint>       # any mint
 */
import '../src/infra/netDefaults';
import 'dotenv/config';
import { BirdeyeMarketProvider } from '../src/data/birdeye';

const DEFAULT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const FRESH_MS = 10_000;

async function main(): Promise<number> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    console.error('BLOCKED: BIRDEYE_API_KEY not set in environment');
    return 2;
  }

  const mint = process.argv[2] ?? DEFAULT_MINT;
  const provider = new BirdeyeMarketProvider(apiKey);

  console.log(`Mint    : ${mint}`);
  console.log(`Provider: ${provider.name ?? 'birdeye'}`);
  console.log('Fetching…\n');

  const t0 = Date.now();
  let snapshot;
  try {
    snapshot = await provider.fetchSnapshot(mint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`BLOCKED: ${msg}`);
    console.error(`elapsed=${Date.now() - t0}ms`);
    return 2;
  }
  const elapsed = Date.now() - t0;

  if (snapshot === null) {
    console.error('INCOMPLETE: provider returned null (Rule 30 partial fields)');
    console.error(`elapsed=${elapsed}ms`);
    return 1;
  }

  const age = Date.now() - snapshot.fetchedAt;
  const isFresh = age >= 0 && age < FRESH_MS;
  const hasPrice = typeof snapshot.priceUsd === 'number' && snapshot.priceUsd > 0;

  console.log(JSON.stringify(snapshot, null, 2));
  console.log(`elapsed=${elapsed}ms age=${age}ms`);

  if (hasPrice && isFresh) {
    console.log('REAL');
    return 0;
  }

  console.error(`UNEXPECTED: price=${snapshot.priceUsd} age=${age}`);
  return 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('UNEXPECTED:', err);
    process.exit(3);
  });
