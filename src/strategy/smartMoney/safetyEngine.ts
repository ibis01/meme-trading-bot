// import { logger } from '../../utils/logger'; <-- Removed unused import

export interface SafetyCheckResult {
  isSafe: boolean;
  reason?: string;
}

export class SafetyEngine {
  // Prefixing tokenMint with _ tells ESLint it is intentionally unused for now.
  static async check(_tokenMint: string): Promise<SafetyCheckResult> {
    return { isSafe: true };
  }
}
