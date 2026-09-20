export class TimeBudget {
  private readonly deadline: number;
  private readonly reserveMs: number;

  constructor(now: number, wallBudgetMs: number, reserveMs: number) {
    this.deadline = now + wallBudgetMs;
    this.reserveMs = reserveMs;
  }

  remaining(now: number): number {
    return Math.max(0, this.deadline - now - this.reserveMs);
  }

  canSpend(estimateMs: number, now: number): boolean {
    return this.remaining(now) >= estimateMs;
  }
}

export const STAGE_ESTIMATES_MS = {
  backfillPage: 20_000,
  checkpoint: 500,
  classification: 45_000,
  discoveryPage: 20_000,
  messageFetch: 20_000,
  mutation: 20_000,
} as const;
