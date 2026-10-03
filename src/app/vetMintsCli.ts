import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { vetMint, VetPair, VetResult } from './vetMints';

const DELAY_MS = 400; // DexScreener allows ~300 req/min

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : undefined;
}

function readMints(file: string): string[] {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) throw new Error(`${file} not found`);
  const seen = new Set<string>();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.split('#')[0].trim();
    if (m) seen.add(m);
  }
  return [...seen];
}

async function fetchPairs(mint: string): Promise<VetPair[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const json = (await res.json()) as { pairs?: VetPair[] };
  return json.pairs ?? [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (n?: number) => (n === undefined ? '-' : `$${Math.round(n).toLocaleString('en-US')}`);

async function main() {
  const input = arg('in') ?? 'candidates.txt';
  const out = arg('out') ?? 'mints.vetted.txt';
  const mints = readMints(input);
  const results: VetResult[] = [];

  for (const mint of mints) {
    try {
      results.push(vetMint(mint, await fetchPairs(mint), Date.now()));
    } catch (err) {
      logger.warn({ mint, err }, 'Fetch failed — marking INCOMPLETE, not guessing');
      results.push({ mint, status: 'INCOMPLETE' });
    }
    await sleep(DELAY_MS);
  }

  console.log('status         symbol       liquidity      vol24h         age(h)  mint');
  for (const r of results) {
    console.log(
      `${r.status.padEnd(14)} ${(r.symbol ?? '-').padEnd(12)} ${usd(r.liquidityUsd).padEnd(14)} ` +
        `${usd(r.volume24hUsd).padEnd(14)} ${(r.ageHours === undefined ? '-' : r.ageHours.toFixed(0)).padEnd(7)} ${r.mint}`,
    );
  }

  const passed = results.filter((r) => r.status === 'PASS');
  fs.writeFileSync(path.resolve(process.cwd(), out), passed.map((r) => `${r.mint} # ${r.symbol ?? ''}`).join('\n') + '\n');
  console.log(`\n${passed.length}/${results.length} passed. Wrote ${out}`);
}

main().catch((err) => {
  logger.fatal({ err }, 'mints:vet failed');
  process.exit(1);
});
