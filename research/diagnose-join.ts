import fs from 'fs';
import readline from 'readline';

const DIR = './research/kaggle-graduation';
const TRAIN = `${DIR}/train.csv`;
const INFO = `${DIR}/token_info_onchain_divers_v2.csv`;

async function firstLines(path: string, n: number): Promise<string[]> {
  const out: string[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) { out.push(line); if (out.length >= n) { rl.close(); break; } }
  return out;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let start = 0, inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { out.push(line.slice(start, i)); start = i + 1; }
  }
  out.push(line.slice(start));
  return out;
}

async function main() {
  console.log('=== Raw byte check on v2 ===');
  const fd = fs.openSync(INFO, 'r');
  const buf = Buffer.alloc(32);
  fs.readSync(fd, buf, 0, 32, 0);
  fs.closeSync(fd);
  console.log('first 32 bytes (hex):', buf.toString('hex'));
  console.log('first 32 bytes (utf8):', JSON.stringify(buf.toString('utf8')));

  console.log('\n=== v2 file: first 2 lines ===');
  const v2Lines = await firstLines(INFO, 2);
  for (let i = 0; i < v2Lines.length; i++) {
    const h = splitLine(v2Lines[i]);
    console.log(`\nline ${i}: rawLen=${v2Lines[i].length} cols=${h.length}`);
    h.forEach((c, idx) => {
      console.log(`  [${idx}] len=${String(c.length).padStart(3)} ${JSON.stringify(c.slice(0, 40))}`);
    });
  }

  console.log('\n=== train.csv: first 3 lines ===');
  const tLines = await firstLines(TRAIN, 3);
  for (const l of tLines) console.log(`  ${JSON.stringify(l.slice(0, 100))}`);

  // Sample 5 mints from each side and cross-check
  console.log('\n=== Mint format cross-check (first 5 from each) ===');
  const v2Mints: string[] = [];
  const trainMints: string[] = [];

  {
    const rl = readline.createInterface({ input: fs.createReadStream(INFO), crlfDelay: Infinity });
    let first = true;
    let idx = -1;
    for await (const line of rl) {
      if (first) { const h = splitLine(line); idx = h.indexOf('mint'); first = false; console.log(`v2 mint idx = ${idx}`); continue; }
      const c = splitLine(line);
      const m = c[idx];
      if (m) v2Mints.push(m);
      if (v2Mints.length >= 5) { rl.close(); break; }
    }
  }
  {
    const rl = readline.createInterface({ input: fs.createReadStream(TRAIN), crlfDelay: Infinity });
    let first = true;
    let idx = -1;
    for await (const line of rl) {
      if (first) { const h = splitLine(line); idx = h.indexOf('mint'); first = false; console.log(`train mint idx = ${idx}`); continue; }
      const c = splitLine(line);
      const m = c[idx];
      if (m) trainMints.push(m);
      if (trainMints.length >= 5) { rl.close(); break; }
    }
  }
  console.log('v2 mints:', v2Mints.map(m => JSON.stringify(m)).join('\n           '));
  console.log('train mints:', trainMints.map(m => JSON.stringify(m)).join('\n              '));
}

main().catch(e => { console.error(e); process.exit(1); });
