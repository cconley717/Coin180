export class WilderMomentumAnalyzer {
  private readonly period: number;
  private last?: number;
  private warmup: number[] = [];
  private avgGain?: number;
  private avgLoss?: number;

  constructor(period = 14) {
    this.period = Math.max(1, period);
  }

  update(value: number): { rsi100: number; rsiNorm: number } | null {
    if (this.last == null) {
      this.last = value;

      return null; // need diffs to begin
    }

    const diff = value - this.last;
    this.last = value;

    // During warmup, collect the last `period` diffs to seed the first RMA
    if (this.avgGain == null || this.avgLoss == null) {
      this.warmup.push(diff);

      if (this.warmup.length < this.period) return null;

      // Seed Wilder averages using simple averages of gains/losses (losses as positive magnitudes)
      let gains = 0;
      let losses = 0;

      for (const d of this.warmup) {
        if (d > 0) gains += d;
        else losses -= d; // d < 0
      }

      this.avgGain = gains / this.period;
      this.avgLoss = losses / this.period;
      this.warmup = [];
    } else {
      // Wilder recurrence (RMA)
      const gain = Math.max(diff, 0);
      const loss = Math.max(-diff, 0);

      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    }

    // Compute RSI (Wilder)
    const EPS = 1e-8;
    const g = this.avgGain ?? 0;
    const l = this.avgLoss ?? 0;

    // Flat window → RSI 50
    if (g < EPS && l < EPS) return { rsi100: 50, rsiNorm: 0 };
    // All gains / no losses → RSI 100
    else if (l < EPS) return { rsi100: 100, rsiNorm: 1 };
    // All losses / no gains → RSI 0
    else if (g < EPS) return { rsi100: 0, rsiNorm: -1 };

    const rs = g / l;

    const rsi100 = Math.max(0, Math.min(100, 100 - 100 / (1 + rs)));
    const rsiNorm = Math.max(-1, Math.min(1, (rsi100 - 50) / 50));

    const result = { rsi100, rsiNorm };

    return result;
  }
}
