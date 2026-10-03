import { LaunchTracker } from '../src/app/launchTracker';

const H = 3_600_000;

describe('LaunchTracker', () => {
  const mk = () => new LaunchTracker({ trackMs: 6 * H, maxTracked: 2 });

  it('tracks a new mint and reports it active', () => {
    const t = mk();
    expect(t.add('A', 0)).toBe('ADDED');
    expect(t.active(1000)).toEqual(['A']);
  });

  it('ignores duplicates', () => {
    const t = mk();
    t.add('A', 0);
    expect(t.add('A', 1000)).toBe('DUPLICATE');
  });

  it('enforces the capacity cap', () => {
    const t = mk();
    t.add('A', 0);
    t.add('B', 0);
    expect(t.add('C', 0)).toBe('AT_CAPACITY');
    expect(t.active(0)).toEqual(['A', 'B']);
  });

  it('expires mints after trackMs and frees capacity', () => {
    const t = mk();
    t.add('A', 0);
    t.add('B', 0);
    expect(t.active(6 * H)).toEqual([]);
    expect(t.add('C', 6 * H)).toBe('ADDED');
  });

  it('never re-tracks a mint after it expired', () => {
    const t = mk();
    t.add('A', 0);
    expect(t.add('A', 7 * H)).toBe('DUPLICATE');
    expect(t.active(7 * H)).toEqual([]);
  });
});
