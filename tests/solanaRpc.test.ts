import { SolanaRpcClient } from '../src/data/solanaRpc';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 500, json: async () => payload }) as Response) as unknown as typeof fetch;

describe('SolanaRpcClient', () => {
  it('returns result from getTransaction', async () => {
    const rpc = new SolanaRpcClient('http://x', mkFetch({
      jsonrpc: '2.0', id: 1, result: { slot: 1, transaction: { message: {} } },
    }));
    const r = await rpc.getTransaction('sig');
    expect(r).not.toBeNull();
  });

  it('returns null on RPC error field', async () => {
    const rpc = new SolanaRpcClient('http://x', mkFetch({
      jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' },
    }));
    expect(await rpc.getTransaction('sig')).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    const rpc = new SolanaRpcClient('http://x', mkFetch({}, false));
    expect(await rpc.getTransaction('sig')).toBeNull();
  });

  it('returns blockhash from getLatestBlockhash', async () => {
    const rpc = new SolanaRpcClient('http://x', mkFetch({
      jsonrpc: '2.0', id: 1, result: { value: { blockhash: 'abc' } },
    }));
    expect(await rpc.getLatestBlockhash()).toBe('abc');
  });
});
