import { randomUUID } from 'crypto';
import {
  ClosePositionInput,
  CloseResult,
  OpenPositionInput,
  Position,
  PositionFill,
  PositionLedger,
} from './types';

export class InMemoryPositionLedger implements PositionLedger {
  private readonly byMint = new Map<string, Position>();
  private readonly fills: PositionFill[] = [];

  async open(input: OpenPositionInput): Promise<Position> {
    validateQuantity(input.quantity);
    validatePrice(input.priceSol);

    const now = Date.now();
    const existing = this.byMint.get(input.tokenMint);

    let updated: Position;
    if (existing && existing.quantity > 0) {
      // Average in.
      const newQty = existing.quantity + input.quantity;
      const newAvg =
        (existing.quantity * existing.avgCostSol + input.quantity * input.priceSol) / newQty;
      updated = {
        ...existing,
        quantity: newQty,
        avgCostSol: newAvg,
        updatedAt: now,
        closedAt: undefined,
      };
    } else {
      // Fresh position (either first-ever or reopening after full close).
      updated = {
        id: existing?.id ?? randomUUID(),
        tokenMint: input.tokenMint,
        quantity: input.quantity,
        avgCostSol: input.priceSol,
        openedAt: now,
        updatedAt: now,
      };
    }

    this.byMint.set(input.tokenMint, updated);
    this.recordFill(updated.id, input.tradeRequestId, 'BUY', input.quantity, input.priceSol, input.signature);
    return { ...updated };
  }

  async close(input: ClosePositionInput): Promise<CloseResult> {
    validateQuantity(input.quantity);
    validatePrice(input.priceSol);

    const existing = this.byMint.get(input.tokenMint);
    if (!existing || existing.quantity <= 0) {
      throw new Error('NO_OPEN_POSITION');
    }
    if (input.quantity > existing.quantity) {
      throw new Error('INSUFFICIENT_QUANTITY');
    }

    const costBasisSol = input.quantity * existing.avgCostSol;
    const proceedsSol = input.quantity * input.priceSol;
    const realizedPnlSol = proceedsSol - costBasisSol;
    const remainingQuantity = existing.quantity - input.quantity;
    const now = Date.now();

    const updated: Position = {
      ...existing,
      quantity: remainingQuantity,
      updatedAt: now,
      closedAt: remainingQuantity === 0 ? now : undefined,
    };
    this.byMint.set(input.tokenMint, updated);

    this.recordFill(existing.id, input.tradeRequestId, 'SELL', input.quantity, input.priceSol, input.signature);

    return { costBasisSol, realizedPnlSol, remainingQuantity };
  }

  async get(tokenMint: string): Promise<Position | null> {
    const p = this.byMint.get(tokenMint);
    return p ? { ...p } : null;
  }

  async list(): Promise<Position[]> {
    return [...this.byMint.values()]
      .filter((p) => p.quantity > 0)
      .map((p) => ({ ...p }));
  }

  async getOpenCount(): Promise<number> {
    let n = 0;
    for (const p of this.byMint.values()) if (p.quantity > 0) n += 1;
    return n;
  }

  async getFills(positionId: string): Promise<PositionFill[]> {
    return this.fills.filter((f) => f.positionId === positionId).map((f) => ({ ...f }));
  }

  private recordFill(
    positionId: string,
    tradeRequestId: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    priceSol: number,
    signature: string,
  ): void {
    if (this.fills.some((f) => f.tradeRequestId === tradeRequestId)) {
      throw new Error('DUPLICATE_TRADE_REQUEST');
    }
    this.fills.push({
      id: randomUUID(),
      positionId,
      tradeRequestId,
      side,
      quantity,
      priceSol,
      totalSol: quantity * priceSol,
      signature,
      executedAt: Date.now(),
    });
  }
}

function validateQuantity(q: number): void {
  if (!Number.isFinite(q) || q <= 0) throw new Error('INVALID_QUANTITY');
}

function validatePrice(p: number): void {
  if (!Number.isFinite(p) || p <= 0) throw new Error('INVALID_PRICE');
}
