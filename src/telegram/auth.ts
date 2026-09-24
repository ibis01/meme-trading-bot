/**
 * Rule 13: Authorization must use immutable user identifiers.
 * Never trust usernames or message content.
 */
export interface AuthResult {
  authorized: boolean;
  reason?: string;
}

export class Authorizer {
  private readonly allowed: Set<number>;

  constructor(allowedIds: readonly number[]) {
    this.allowed = new Set(allowedIds);
  }

  isAuthorized(userId: number | undefined): AuthResult {
    if (typeof userId !== 'number' || !Number.isInteger(userId)) {
      return { authorized: false, reason: 'MISSING_USER_ID' };
    }
    if (!this.allowed.has(userId)) {
      return { authorized: false, reason: 'USER_NOT_ALLOWED' };
    }
    return { authorized: true };
  }
}

export function parseAuthorizedIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}
