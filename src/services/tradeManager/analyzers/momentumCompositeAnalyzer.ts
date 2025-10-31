import type { MomentumCompositeAnalyzerOptions } from '../core/options.js';
import { TradeSignal, type TradeSignalAnalyzerResult, type MomentumCompositeAnalyzerDebug } from '../core/types.js';
import { WilderMomentumAnalyzer } from './wilderMomentumAnalyzer.js';

export class MomentumCompositeAnalyzer {
  private readonly history: number[] = [];
  private readonly rsiPeriod: number;
  private readonly zWindow: number;
  private readonly buyThreshold: number;
  private readonly sellThreshold: number;
  private readonly hysteresisCount: number;
  private readonly rsiWeight: number;
  private readonly zWeight: number;
  private readonly adaptive: boolean;
  private readonly adaptiveMinWindow: number;
  private readonly adaptiveMaxWindow: number;
  private readonly adaptiveSensitivity: number;
  private readonly adaptiveVolScale: number;
  private readonly confidenceDecayRate: number;

  private pendingSignal: TradeSignal = TradeSignal.Neutral;
  private lastSignal: TradeSignal = TradeSignal.Neutral;
  private hysteresisBuffer = 0;
  private persistenceSteps = 0;

  private readonly wilderMomentumAnalyzer: WilderMomentumAnalyzer;
  private lastDebug: MomentumCompositeAnalyzerDebug | null = null;

  constructor(options: MomentumCompositeAnalyzerOptions) {
    if (!options) throw new Error('MomentumCompositeAnalyzer requires explicit options.');

    this.rsiPeriod = options.rsiPeriod;
    this.zWindow = options.zWindow;

    this.buyThreshold = options.buyThreshold;
    this.sellThreshold = options.sellThreshold;

    if (!(this.sellThreshold < 0 && this.buyThreshold > 0)) {
      throw new Error(
        `MomentumCompositeAnalyzer: buy/sell thresholds must straddle 0 (sell < 0 < buy). Received sell=${this.sellThreshold}, buy=${this.buyThreshold}`
      );
    }
    if (this.buyThreshold > 1 || this.sellThreshold < -1) {
      throw new Error(
        `MomentumCompositeAnalyzer: thresholds must be within [-1, 1]. Received sell=${this.sellThreshold}, buy=${this.buyThreshold}`
      );
    }

    this.hysteresisCount = options.hysteresisCount;
    this.rsiWeight = options.rsiWeight;
    this.zWeight = options.zWeight;
    this.adaptive = options.adaptive;
    this.adaptiveMinWindow = options.adaptiveMinWindow;
    this.adaptiveMaxWindow = options.adaptiveMaxWindow;
    this.adaptiveSensitivity = options.adaptiveSensitivity;
    this.adaptiveVolScale = options.adaptiveVolScale;
    this.confidenceDecayRate = options.confidenceDecayRate;

    this.wilderMomentumAnalyzer = new WilderMomentumAnalyzer(this.rsiPeriod);
  }

  public getDebugSnapshot(): MomentumCompositeAnalyzerDebug | null {
    if (!this.lastDebug) return null;

    return { ...this.lastDebug };
  }

  private computeAdaptiveZWindow(): number {
    if (!this.adaptive || this.history.length < this.zWindow) return this.zWindow;

    const recent = this.history.slice(-this.zWindow);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    const normalized = Math.min(1, (stdDev / this.adaptiveVolScale) * this.adaptiveSensitivity);
    const adaptiveSize = Math.round(
      this.adaptiveMaxWindow - normalized * (this.adaptiveMaxWindow - this.adaptiveMinWindow)
    );

    return Math.max(this.adaptiveMinWindow, Math.min(this.adaptiveMaxWindow, adaptiveSize));
  }

  private computeZScore(data: number[]): number | null {
    const zWindow = this.computeAdaptiveZWindow();

    if (data.length < zWindow) return null;

    const recent = data.slice(-zWindow);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(Math.max(variance, 1e-6));
    const latest = data.at(-1)!;
    const z = (latest - mean) / stdDev;

    return Math.max(-1, Math.min(1, z / 3));
  }

  private applyHysteresis(newSignal: TradeSignal): TradeSignal {
    if (newSignal === TradeSignal.Neutral) {
      this.pendingSignal = TradeSignal.Neutral;
      this.hysteresisBuffer = 0;
      return TradeSignal.Neutral;
    }

    if (this.pendingSignal === newSignal) {
      this.hysteresisBuffer++;
    } else {
      this.pendingSignal = newSignal;
      this.hysteresisBuffer = 1;
    }

    if (this.hysteresisBuffer >= this.hysteresisCount && this.lastSignal !== newSignal) {
      this.lastSignal = newSignal;
      this.hysteresisBuffer = 0;
      this.pendingSignal = TradeSignal.Neutral;
      this.persistenceSteps = 0;

      return newSignal;
    }

    return TradeSignal.Neutral;
  }

  public update(score: number): TradeSignalAnalyzerResult {
    this.history.push(score);

    const currentZWindow = this.computeAdaptiveZWindow();
    const maxHistory = Math.max(this.rsiPeriod, currentZWindow) * 2;
    if (this.history.length > maxHistory) this.history.splice(0, this.history.length - maxHistory);

    let rsi: number | null = null;
    let z: number | null = null;
    let composite: number | null = null;
    let intent: TradeSignal = TradeSignal.Neutral;
    let confirmedSignal: TradeSignal = TradeSignal.Neutral;
    let confidenceBeforeDecay: number | null = null;
    let confidenceAfterDecay: number | null = null;

    const recordDebug = (reason: string) => {
      this.lastDebug = {
        reason,
        adaptiveWindow: currentZWindow,
        rsiNorm: rsi,
        zScore: z,
        composite,
        intent,
        confirmedSignal,
        pendingSignal: this.pendingSignal,
        hysteresisBuffer: this.hysteresisBuffer,
        persistenceSteps: this.persistenceSteps,
        confidenceBeforeDecay,
        confidenceAfterDecay,
      };
    };

    const rsiOut = this.wilderMomentumAnalyzer.update(score);
    if (!rsiOut) {
      recordDebug('insufficient_rsi_history');
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }
    rsi = rsiOut.rsiNorm;

    z = this.computeZScore(this.history);
    if (z === null) {
      recordDebug('insufficient_z_history');
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    const weightSum = this.rsiWeight + this.zWeight;
    const wRSI = weightSum > 0 ? this.rsiWeight / weightSum : 0.5;
    const wZ = weightSum > 0 ? this.zWeight / weightSum : 0.5;

    composite = wRSI * rsi + wZ * z;

    if (composite >= this.buyThreshold) intent = TradeSignal.Buy;
    else if (composite <= this.sellThreshold) intent = TradeSignal.Sell;

    const tradeSignal = this.applyHysteresis(intent);
    confirmedSignal = tradeSignal;

    confidenceBeforeDecay = Math.min(1, Math.abs(composite));
    let confidence = confidenceBeforeDecay;

    if (intent !== TradeSignal.Neutral && intent === this.lastSignal) {
      this.persistenceSteps++;
      confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
    } else if (intent !== TradeSignal.Neutral) {
      this.persistenceSteps = 0;
      // Fresh signal - no decay on first appearance
    } else {
      this.persistenceSteps = 0;
    }

    confidenceAfterDecay = confidence;

    if (tradeSignal === TradeSignal.Neutral) {
      recordDebug('neutral_output');
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    recordDebug('signal_emitted');
    return { tradeSignal, confidence };
  }
}
