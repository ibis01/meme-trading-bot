import { InMemoryExecutionStore } from '../src/state/executions';

const mk = (o = {}) => ({
  id: 'e1', proposalId: 'p1', tradeRequestId: 'tr_1',
  txSignature: 'sig_1', status: 'CONFIRMED' as const, executedAt: Date.now(), ...o,
});

describe('ExecutionStore (Rule 24)', () => {
  it('refuses duplicate tx signatures', async () => {
    const s = new InMemoryExecutionStore();
    await s.save(mk({ id: 'e1', tradeRequestId: 'tr_1', txSignature: 'sig_x' }));
    await s.save(mk({ id: 'e2', tradeRequestId: 'tr_2', txSignature: 'sig_x' }));
    expect(await s.getByRequestId('tr_2')).toBeNull();
    expect(await s.getByRequestId('tr_1')).not.toBeNull();
  });

  it('allows different signatures', async () => {
    const s = new InMemoryExecutionStore();
    await s.save(mk({ id: 'e1', tradeRequestId: 'tr_1', txSignature: 'sig_a' }));
    await s.save(mk({ id: 'e2', tradeRequestId: 'tr_2', txSignature: 'sig_b' }));
    expect(await s.getBySignature('sig_a')).not.toBeNull();
    expect(await s.getBySignature('sig_b')).not.toBeNull();
  });

  it('updateStatus mutates only status', async () => {
    const s = new InMemoryExecutionStore();
    await s.save(mk());
    await s.updateStatus('e1', 'FAILED', 'boom');
    const loaded = await s.getByRequestId('tr_1');
    expect(loaded!.status).toBe('FAILED');
    expect(loaded!.error).toBe('boom');
  });
});
