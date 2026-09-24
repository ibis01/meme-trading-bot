import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import bs58 from 'bs58';
import { config } from '../config';
import { SolanaRpcClient } from '../data/solanaRpc';
import { logger } from '../utils/logger';

interface CapturedInstruction {
  programId: string;
  accounts: string[];
  dataBase58: string;
  dataLength: number;
  /** Hex of the first 8 bytes (Anchor discriminator). */
  discriminatorHex: string;
  /** Index of the parent instruction, if this is an inner ix. */
  parentProgramId?: string;
}

interface CapturedTx {
  signature: string;
  slot: number;
  matchingLogLines: string[];
  accountKeys: string[];
  outerInstructions: CapturedInstruction[];
  innerInstructions: CapturedInstruction[];
  rawLogs: string[];
}

interface Args {
  program: string;
  instructionPattern: string;
  count: number;
  out: string;
  seconds: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const program = get('program');
  const instructionPattern = get('instruction');
  if (!program) throw new Error('--program required');
  if (!instructionPattern) throw new Error('--instruction required');
  return {
    program,
    instructionPattern,
    count: Number(get('count') ?? 5),
    out: get('out') ?? 'capture-full.json',
    seconds: Number(get('seconds') ?? 120),
  };
}

function toHex(buf: Buffer, max = 8): string {
  return buf.subarray(0, max).toString('hex');
}

function normalizeInstruction(
  rawIx: unknown,
  accountKeys: string[],
  parentProgramId?: string,
): CapturedInstruction | null {
  if (!rawIx || typeof rawIx !== 'object') return null;
  const ix = rawIx as Record<string, unknown>;

  let programId = '';
  if (typeof ix.programId === 'string') programId = ix.programId;
  else if (typeof ix.programIdIndex === 'number') programId = accountKeys[ix.programIdIndex] ?? '';
  if (!programId) return null;

  const accounts: string[] = [];
  if (Array.isArray(ix.accounts)) {
    for (const a of ix.accounts) {
      if (typeof a === 'number') accounts.push(accountKeys[a] ?? '');
      else if (typeof a === 'string') accounts.push(a);
      else if (a && typeof a === 'object' && 'pubkey' in a) accounts.push(String((a as { pubkey: unknown }).pubkey));
    }
  }

  let dataBuf = Buffer.alloc(0);
  if (typeof ix.data === 'string') {
    try { dataBuf = Buffer.from(bs58.decode(ix.data)); } catch { /* ignore */ }
  }

  return {
    programId,
    accounts,
    dataBase58: typeof ix.data === 'string' ? ix.data : '',
    dataLength: dataBuf.length,
    discriminatorHex: toHex(dataBuf),
    parentProgramId,
  };
}

async function main() {
  const args = parseArgs();
  const wsUrl = config.HELIUS_WS_URL;
  const rpcUrl = config.SOLANA_RPC_URL;
  if (!wsUrl || !rpcUrl) { logger.fatal('endpoints not set'); process.exit(1); }

  const rpc = new SolanaRpcClient(rpcUrl);
  const pattern = new RegExp(args.instructionPattern, 'i');
  const captured: CapturedTx[] = [];
  const seen = new Set<string>();
  const ws = new WebSocket(wsUrl);

  logger.info(
    { program: args.program, instructionPattern: args.instructionPattern, target: args.count },
    'Capturing full transactions (outer + inner)',
  );

  const done = new Promise<void>((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [args.program] }, { commitment: 'confirmed' }],
      }));
    });

    ws.on('message', async (raw) => {
      let parsed: { method?: string; params?: { result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } } } };
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (parsed.method !== 'logsNotification') return;

      const value = parsed.params?.result?.value;
      const slot = parsed.params?.result?.context?.slot ?? 0;
      if (!value || value.err) return;
      const sig = value.signature;
      if (!sig || seen.has(sig)) return;
      seen.add(sig);

      const logs = value.logs ?? [];
      const matchingLines = logs.filter((l) => pattern.test(l));
      if (matchingLines.length === 0) return;

      logger.info({ signature: sig, matched: matchingLines[0] }, 'Found matching tx — fetching full');

      const tx = await rpc.getTransaction(sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 });
      if (!tx) { logger.warn({ signature: sig }, 'getTransaction null'); return; }

      const result = tx as {
        transaction?: { message?: { accountKeys?: unknown[]; instructions?: unknown[] } };
        meta?: { innerInstructions?: Array<{ index?: number; instructions?: unknown[] }> };
      };
      const message = result.transaction?.message;
      if (!message) return;

      const accountKeys = (message.accountKeys ?? []).map((k) => {
        if (typeof k === 'string') return k;
        if (k && typeof k === 'object' && 'pubkey' in k) return String((k as { pubkey: unknown }).pubkey);
        return '';
      });

      const outerInstructions: CapturedInstruction[] = [];
      for (const ix of message.instructions ?? []) {
        const norm = normalizeInstruction(ix, accountKeys);
        if (norm) outerInstructions.push(norm);
      }

      const innerInstructions: CapturedInstruction[] = [];
      for (const innerGroup of result.meta?.innerInstructions ?? []) {
        // Find which outer instruction this group belongs to.
        const parentIdx = innerGroup.index ?? -1;
        const parentProgramId = parentIdx >= 0 ? outerInstructions[parentIdx]?.programId : undefined;
        for (const innerIx of innerGroup.instructions ?? []) {
          const norm = normalizeInstruction(innerIx, accountKeys, parentProgramId);
          if (norm) innerInstructions.push(norm);
        }
      }

      captured.push({
        signature: sig,
        slot,
        matchingLogLines: matchingLines,
        accountKeys,
        outerInstructions,
        innerInstructions,
        rawLogs: logs,
      });

      logger.info(
        {
          total: captured.length,
          target: args.count,
          outer: outerInstructions.length,
          inner: innerInstructions.length,
        },
        'Captured',
      );

      if (captured.length >= args.count) {
        const out = path.resolve(process.cwd(), args.out);
        fs.writeFileSync(out, JSON.stringify(captured, null, 2), 'utf8');
        logger.info({ out, count: captured.length }, 'Wrote captures');
        ws.close();
        resolve();
      }
    });

    ws.on('error', (err) => logger.warn({ err: String(err) }, 'WS error'));

    setTimeout(() => {
      const out = path.resolve(process.cwd(), args.out);
      fs.writeFileSync(out, JSON.stringify(captured, null, 2), 'utf8');
      logger.info({ out, count: captured.length }, 'Timeout');
      ws.close();
      resolve();
    }, args.seconds * 1000);
  });

  await done;
  process.exit(0);
}

main().catch((err) => { logger.fatal({ err }, 'capture failed'); process.exit(1); });
