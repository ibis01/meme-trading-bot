import { Authorizer, parseAuthorizedIds } from '../src/telegram/auth';

describe('Authorizer (Rule 13)', () => {
  const a = new Authorizer([111, 222]);

  it('rejects undefined user id', () => {
    expect(a.isAuthorized(undefined).reason).toBe('MISSING_USER_ID');
  });

  it('rejects non-integer user id', () => {
    expect(a.isAuthorized(1.5).reason).toBe('MISSING_USER_ID');
  });

  it('rejects unknown user', () => {
    expect(a.isAuthorized(999).reason).toBe('USER_NOT_ALLOWED');
  });

  it('allows whitelisted user', () => {
    expect(a.isAuthorized(111).authorized).toBe(true);
  });

  it('parses comma-separated ids, drops junk', () => {
    expect(parseAuthorizedIds('111, 222 ,, abc, -5')).toEqual([111, 222]);
  });
});
