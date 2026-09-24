import { config } from '../config';
import { ExecutionProvider, ExecutionRequest, ExecutionOutcome } from './types';

/**
 * Rule 34: live trading must be explicitly enabled.
 * Rule 12: never expose private keys. This skeleton refuses to run
 * until a reviewed signing path (Jito + private RPC) is implemented.
 */
export class LiveExecutionProvider implements ExecutionProvider {
  readonly name = 'live';

  assertEnabled(): void {
    if (config.TRADING_MODE !== 'live') {
      throw new Error('LIVE_PROVIDER_REQUIRES_TRADING_MODE_LIVE');
    }
    if (!config.WALLET_PRIVATE_KEY) {
      throw new Error('LIVE_PROVIDER_MISSING_WALLET_PRIVATE_KEY');
    }
  }

  async execute(_req: ExecutionRequest): Promise<ExecutionOutcome> {
    // Deliberately unimplemented. Task 011+ will add Jito + signing.
    throw new Error('LIVE_EXECUTION_NOT_IMPLEMENTED');
  }
}
