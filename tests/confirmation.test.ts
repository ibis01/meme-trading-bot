import { ConfirmationManager } from '../src/telegram/confirmation';

describe('ConfirmationManager (Rule 13)', () => {
  it('registers and consumes a matching confirmation', () => {
    const cm = new ConfirmationManager(60_000);
    cm.register(1, 'BUY', { tokenMint: 'm', amountSol: 0.1 }, 'confirm');
    const result = cm.consume(1, 'BUY', 'confirm');
    expect(result).not.toBeNull();
    expect((result!.payload as { tokenMint: string }).tokenMint).toBe('m');
  });

  it('case-insensitive match', () => {
    const cm = new ConfirmationManager(60_000);
    cm.register(1, 'BUY', {}, 'confirm');
    expect(cm.consume(1, 'BUY', 'CONFIRM')).not.toBeNull();
  });

  it('rejects wrong text', () => {
    const cm = new ConfirmationManager(60_000);
    cm.register(1, 'BUY', {}, 'confirm');
    expect(cm.consume(1, 'BUY', 'yes')).toBeNull();
  });

  it('rejects expired confirmations', () => {
    const cm = new ConfirmationManager(-1); // already expired
    cm.register(1, 'BUY', {}, 'confirm');
    expect(cm.consume(1, 'BUY', 'confirm')).toBeNull();
  });

  it('consuming removes the pending', () => {
    const cm = new ConfirmationManager(60_000);
    cm.register(1, 'BUY', {}, 'confirm');
    cm.consume(1, 'BUY', 'confirm');
    expect(cm.consume(1, 'BUY', 'confirm')).toBeNull();
  });

  it('isolates users', () => {
    const cm = new ConfirmationManager(60_000);
    cm.register(1, 'BUY', { tokenMint: 'a' }, 'confirm');
    expect(cm.consume(2, 'BUY', 'confirm')).toBeNull();
    expect(cm.consume(1, 'BUY', 'confirm')).not.toBeNull();
  });

  it('isolates kinds', () => {
    const cm = new ConfirmationManager(60_000);
    cm.register(1, 'BUY', {}, 'confirm');
    expect(cm.consume(1, 'SELL', 'confirm')).toBeNull();
    expect(cm.consume(1, 'BUY', 'confirm')).not.toBeNull();
  });

  it('closeall requires the exact phrase', () => {
    const cm = new ConfirmationManager(60_000);
    cm.register(1, 'CLOSE_ALL', {}, 'CONFIRM CLOSE ALL');
    expect(cm.consume(1, 'CLOSE_ALL', 'confirm')).toBeNull();
    expect(cm.consume(1, 'CLOSE_ALL', 'CONFIRM CLOSE ALL')).not.toBeNull();
  });
});
