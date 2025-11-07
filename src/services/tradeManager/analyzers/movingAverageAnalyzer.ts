import type { MovingAverageAnalyzerOptions } from '../core/options.js';
import { TradeSignal, type TradeSignalAnalyzerResult, type MovingAverageAnalyzerDebug } from '../core/types.js';

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
  private readonly minSignalBuyConfidence: number;
  private readonly minSignalSellConfidence: number;

  private lastTradeSignal: TradeSignal = TradeSignal.Neutral;
  private pendingTradeSignal: TradeSignal = TradeSignal.Neutral;
  private hysteresisBuffer = 0;
  private persistenceSteps = 0;
  private lastDebug: MovingAverageAnalyzerDebug | null = null;

  constructor(options: MovingAverageAnalyzerOptions) {
    if (!options) throw new Error('MovingAverageAnalyzer requires explicit options.');

    this.shortWindow = options.shortWindow;
    this.longWindow = options.longWindow;

    if (this.longWindow <= this.shortWindow) {
      throw new Error('MovingAverageAnalyzer longWindow must be greater than shortWindow.');
    }

    this.hysteresisCount = options.hysteresisCount;
    this.adaptive = options.adaptive;
    this.adaptiveMinWindow = Math.max(2, options.adaptiveMinWindow);
    this.adaptiveMaxWindow = Math.max(this.adaptiveMinWindow + 1, options.adaptiveMaxWindow);
    this.adaptiveSensitivity = options.adaptiveSensitivity;
    this.adaptiveVolScale = options.adaptiveVolScale;
    this.confidenceDecayRate = options.confidenceDecayRate;
    this.minSignalBuyConfidence = options.minSignalBuyConfidence;
    this.minSignalSellConfidence = options.minSignalSellConfidence;
  }

  public getDebugSnapshot(): MovingAverageAnalyzerDebug | null {
    if (!this.lastDebug) return null;

    return { ...this.lastDebug };
  }

  private movingAverage(history: number[], window: number): number | null {
    if (history.length < window) return null;

    const slice = history.slice(-window);
    return slice.reduce((a, b) => a + b, 0) / window;
  }

  private computeAdaptiveWindows(): { short: number; long: number } {
    if (!this.adaptive || this.history.length < this.longWindow)
      return { short: this.shortWindow, long: this.longWindow };

    const recent = this.history.slice(-this.longWindow);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    const normalized = Math.min(1, (stdDev / this.adaptiveVolScale) * this.adaptiveSensitivity);
    const adaptiveLong = Math.round(
      this.adaptiveMaxWindow - normalized * (this.adaptiveMaxWindow - this.adaptiveMinWindow)
    );

    const boundedLong = Math.max(this.adaptiveMinWindow, Math.min(this.adaptiveMaxWindow, adaptiveLong));
    const boundedShort = Math.max(
      this.adaptiveMinWindow,
      Math.min(this.adaptiveMaxWindow, Math.round(boundedLong / 3))
    );

    const short = Math.min(boundedShort, Math.max(this.adaptiveMinWindow, boundedLong - 1));
    const long = Math.max(boundedLong, short + 1);

    return { short, long };
  }

  private getAverages(adaptiveShort: number, adaptiveLong: number) {
    const currentShortMA = this.movingAverage(this.history, adaptiveShort);
    const currentLongMA = this.movingAverage(this.history, adaptiveLong);
    const previousHistory = this.history.slice(0, -1);
    const previousShortMA = this.movingAverage(previousHistory, adaptiveShort);
    const previousLongMA = this.movingAverage(previousHistory, adaptiveLong);

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
      this.persistenceSteps = 0;
      return newTradeSignal;
    }

    return TradeSignal.Neutral;
  }

  private computeSpreadStdDev(shortWin: number, longWin: number): number | null {
    if (this.history.length < longWin + 1) return null;

    const spreads: number[] = [];
    for (let i = this.history.length - longWin; i < this.history.length; i++) {
      const prefix = this.history.slice(0, i + 1);
      const s = this.movingAverage(prefix, shortWin);
      const l = this.movingAverage(prefix, longWin);
      if (s === null || l === null) continue;

      spreads.push(s - l);
    }

    if (spreads.length < Math.max(5, Math.floor(longWin / 3))) return null;

    const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const variance = spreads.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / spreads.length;
    return Math.sqrt(variance);
  }

  public update(score: number): TradeSignalAnalyzerResult {
    this.history.push(score);

    const { short, long } = this.computeAdaptiveWindows();
    const maxHistory = long * 2;
    if (this.history.length > maxHistory) this.history.splice(0, this.history.length - maxHistory);

    if (this.history.length < long + 1) {
      this.lastDebug = {
        reason: 'insufficient_history',
        adaptiveShort: short,
        adaptiveLong: long,
        currentShortMA: null,
        currentLongMA: null,
        previousShortMA: null,
        previousLongMA: null,
        spread: null,
        spreadStd: null,
        intent: TradeSignal.Neutral,
        confirmedSignal: this.lastTradeSignal,
        pendingSignal: this.pendingTradeSignal,
        hysteresisBuffer: this.hysteresisBuffer,
        persistenceSteps: this.persistenceSteps,
      };

      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    const averages = this.getAverages(short, long);
    const { currentShortMA, currentLongMA, previousShortMA, previousLongMA } = averages;

    if (currentShortMA === null || currentLongMA === null || previousShortMA === null || previousLongMA === null) {
      this.lastDebug = {
        reason: 'insufficient_ma_values',
        adaptiveShort: short,
        adaptiveLong: long,
        currentShortMA,
        currentLongMA,
        previousShortMA,
        previousLongMA,
        spread: null,
        spreadStd: null,
        intent: TradeSignal.Neutral,
        confirmedSignal: this.lastTradeSignal,
        pendingSignal: this.pendingTradeSignal,
        hysteresisBuffer: this.hysteresisBuffer,
        persistenceSteps: this.persistenceSteps,
      };

      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    const intent = this.detectSignal(currentShortMA, currentLongMA, previousShortMA, previousLongMA);
    const tradeSignal = this.applyHysteresis(intent);

    const spreadValue = Math.abs(currentShortMA - currentLongMA);
    const spreadStd = this.computeSpreadStdDev(short, long);

    let confidence = 0;
    if (spreadStd !== null && spreadStd > 1e-9) {
      confidence = Math.max(0, Math.min(1, spreadValue / (spreadStd * 3)));
    } else {
      const denom = Math.abs(currentLongMA) * 0.05 + 1e-6;
      confidence = Math.max(0, Math.min(1, spreadValue / denom));
    }

    if (intent !== TradeSignal.Neutral && intent === this.lastTradeSignal) {
      this.persistenceSteps++;
      confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
    } else if (intent !== TradeSignal.Neutral) {
      this.persistenceSteps = 0;
      // Fresh signal - no decay on first appearance
    } else {
      this.persistenceSteps = 0;
    }

    this.lastDebug = {
      reason: tradeSignal === TradeSignal.Neutral ? 'neutral_output' : 'signal_emitted',
      adaptiveShort: short,
      adaptiveLong: long,
      currentShortMA,
      currentLongMA,
      previousShortMA,
      previousLongMA,
      spread: spreadValue,
      spreadStd,
      intent,
      confirmedSignal: tradeSignal,
      pendingSignal: this.pendingTradeSignal,
      hysteresisBuffer: this.hysteresisBuffer,
      persistenceSteps: this.persistenceSteps,
    };

    if (tradeSignal === TradeSignal.Neutral) return { tradeSignal: TradeSignal.Neutral, confidence: 0 };

    // Apply confidence thresholds
    if (tradeSignal === TradeSignal.Buy && confidence < this.minSignalBuyConfidence) {
      return { tradeSignal: TradeSignal.Neutral, confidence };
    }
    if (tradeSignal === TradeSignal.Sell && confidence < this.minSignalSellConfidence) {
      return { tradeSignal: TradeSignal.Neutral, confidence };
    }

    return { tradeSignal, confidence };
  }
}
