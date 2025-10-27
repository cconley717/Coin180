import type { MovingAverageAnalyzerOptions } from "../core/options.js";
import { TradeSignal, type TradeSignalAnalyzerResult } from "../core/types.js";

export class MovingAverageAnalyzer {
  private readonly history: number[] = [];
  private readonly shortWindow: number;
  private readonly longWindow: number;
  private readonly hysteresisCount: number;

  private readonly adaptive: boolean;
  private readonly adaptiveMinWindow: number;
  private readonly adaptiveMaxWindow: number;
  private readonly adaptiveSensitivity: number;
  private readonly adaptiveVolScale: number;

  private readonly confidenceDecayRate: number;

  private lastTradeSignal: TradeSignal = TradeSignal.Neutral;   // last confirmed signal
  private pendingTradeSignal: TradeSignal = TradeSignal.Neutral; // candidate awaiting consecutive confirmation
  private hysteresisBuffer = 0;

  private persistenceSteps = 0; // counts consecutive intent ticks for decay

  constructor(options: MovingAverageAnalyzerOptions) {
    if (!options)
      throw new Error('MovingAverageAnalyzer requires explicit options.');

    this.shortWindow = options.shortWindow;
    this.longWindow = options.longWindow;

    if (this.longWindow <= this.shortWindow) {
      throw new Error('MovingAverageAnalyzer longWindow must be greater than shortWindow.');
    }

    this.hysteresisCount = options.hysteresisCount;

    this.adaptive = options.adaptive;
    this.adaptiveMinWindow = Math.max(2, options.adaptiveMinWindow);
    this.adaptiveMaxWindow = Math.max(
      this.adaptiveMinWindow + 1,
      options.adaptiveMaxWindow
    );
    this.adaptiveSensitivity = options.adaptiveSensitivity;
    this.adaptiveVolScale = options.adaptiveVolScale; // replaces hard-coded 50

    this.confidenceDecayRate = options.confidenceDecayRate; // lower = slower decay
  }

  private movingAverage(history: number[], window: number): number | null {
    if (history.length < window) return null;
    const slice = history.slice(-window);
    return slice.reduce((a, b) => a + b, 0) / window;
  }

  private computeAdaptiveWindows(): { short: number; long: number } {
    if (!this.adaptive || this.history.length < this.longWindow) {
      return { short: this.shortWindow, long: this.longWindow };
    }

    const recent = this.history.slice(-this.longWindow);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    // 🔹 Use configurable scale for normalization
    const normalized = Math.min(1, (stdDev / this.adaptiveVolScale) * this.adaptiveSensitivity);

    const adaptiveLong = Math.round(
      this.adaptiveMaxWindow - normalized * (this.adaptiveMaxWindow - this.adaptiveMinWindow)
    );

    const boundedLong = Math.max(this.adaptiveMinWindow, Math.min(this.adaptiveMaxWindow, adaptiveLong));
    const boundedShort = Math.max(this.adaptiveMinWindow, Math.min(this.adaptiveMaxWindow, Math.round(boundedLong / 3)));

    // keep invariant short < long
    const short = Math.min(boundedShort, Math.max(this.adaptiveMinWindow, boundedLong - 1));
    const long = Math.max(boundedLong, short + 1);

    return { short, long };
  }

  private getAverages(adaptiveShort: number, adaptiveLong: number) {
    const currentShortMA = this.movingAverage(this.history, adaptiveShort);
    const currentLongMA = this.movingAverage(this.history, adaptiveLong);
    const previousShortMA = this.movingAverage(this.history.slice(0, -1), adaptiveShort);
    const previousLongMA = this.movingAverage(this.history.slice(0, -1), adaptiveLong);
    return { currentShortMA, currentLongMA, previousShortMA, previousLongMA };
  }

  private detectSignal(
    currentShortMA: number,
    currentLongMA: number,
    previousShortMA: number,
    previousLongMA: number
  ): TradeSignal {
    const wasBullish = previousShortMA > previousLongMA;
    const isBullish = currentShortMA > currentLongMA;

    if (isBullish && !wasBullish) return TradeSignal.Buy;
    if (!isBullish && wasBullish) return TradeSignal.Sell;
    return TradeSignal.Neutral;
  }

  private applyHysteresis(newTradeSignal: TradeSignal): TradeSignal {
    // 🔹 Neutral resets progress so only consecutive evidence confirms
    if (newTradeSignal === TradeSignal.Neutral) {
      this.pendingTradeSignal = TradeSignal.Neutral;
      this.hysteresisBuffer = 0;
      return TradeSignal.Neutral;
    }

    if (this.pendingTradeSignal === newTradeSignal) {
      this.hysteresisBuffer++;
    } else {
      this.pendingTradeSignal = newTradeSignal;
      this.hysteresisBuffer = 1;
    }

    if (this.hysteresisBuffer >= this.hysteresisCount && this.lastTradeSignal !== newTradeSignal) {
      this.lastTradeSignal = newTradeSignal;
      this.hysteresisBuffer = 0;
      this.pendingTradeSignal = TradeSignal.Neutral;
      this.persistenceSteps = 0; // reset persistence on confirmation
      return newTradeSignal;
    }

    return TradeSignal.Neutral;
  }

  private computeSpreadStdDev(shortWin: number, longWin: number): number | null {
    // Try to estimate variability of the spread (shortMA - longMA) over the last `longWin` points.
    if (this.history.length < longWin + 1)
      return null;

    const spreads: number[] = [];
    
    // build spreads using trailing windows ending at each index
    for (let i = this.history.length - longWin; i < this.history.length; i++) {
      const prefix = this.history.slice(0, i + 1);
      const s = this.movingAverage(prefix, shortWin);
      const l = this.movingAverage(prefix, longWin);
      if (s === null || l === null)
        continue;

      spreads.push(s - l);
    }

    if (spreads.length < Math.max(5, Math.floor(longWin / 3)))
      return null;

    const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const variance = spreads.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / spreads.length;

    return Math.sqrt(variance);
  }

  public update(score: number): TradeSignalAnalyzerResult {
    this.history.push(score);

    // 🔹 Compute adaptive windows first, then cap history based on the current long window
    const { short, long } = this.computeAdaptiveWindows();
    const maxHistory = long * 2;
    if (this.history.length > maxHistory) {
      this.history.splice(0, this.history.length - maxHistory);
    }

    // 🔹 Off-by-one fix: need long + 1 to form both current and previous MAs
    if (this.history.length < long + 1) {
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    const { currentShortMA, currentLongMA, previousShortMA, previousLongMA } =
      this.getAverages(short, long);

    if (
      currentShortMA === null ||
      currentLongMA === null ||
      previousShortMA === null ||
      previousLongMA === null
    ) {
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    // 🔹 Directional INTENT (pre-hysteresis)
    const intent = this.detectSignal(
      currentShortMA,
      currentLongMA,
      previousShortMA,
      previousLongMA
    );

    // 🔹 Apply hysteresis (consecutive evidence only)
    const tradeSignal = this.applyHysteresis(intent);

    // ---------- Confidence ----------
    // Prefer std-dev of recent spread for scale; fallback to %-of-long-MA if insufficient
    const spread = Math.abs(currentShortMA - currentLongMA);
    const spreadStd = this.computeSpreadStdDev(short, long);
    let confidence = 0;

    if (spreadStd !== null && spreadStd > 1e-9) {
      const z = spread / (spreadStd * 3);   // ~3σ to reach full confidence
      confidence = Math.max(0, Math.min(1, z));
    } else {
      const denom = Math.abs(currentLongMA) * 0.05 + 1e-6; // fallback
      confidence = Math.max(0, Math.min(1, spread / denom));
    }

    // 🔹 Decay based on INTENT persistence (not emitted signal)
    if (intent !== TradeSignal.Neutral && intent === this.lastTradeSignal) {
      this.persistenceSteps++;
      confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
    } else if (intent !== TradeSignal.Neutral) {
      this.persistenceSteps = 1;
      confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
    } else {
      this.persistenceSteps = 0;
    }

    // 🔹 Neutral emits zero confidence (consistent with your other analyzers)
    if (tradeSignal === TradeSignal.Neutral) {
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    return { tradeSignal, confidence };
  }
}
