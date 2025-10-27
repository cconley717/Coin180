import type { SlopeSignAnalyzerOptions } from "../core/options.js";
import {
  TradeSignal,
  type TradeSignalAnalyzerResult,
  type SlopeSignAnalyzerDebug,
  SlopeDirection
} from "../core/types.js";

export class SlopeSignAnalyzer {
  private readonly history: number[] = [];
  private readonly slopeWindow: number;
  private readonly minSlopeMagnitude: number;
  private readonly hysteresisCount: number;
  private readonly adaptive: boolean;
  private readonly adaptiveMinWindow: number;
  private readonly adaptiveMaxWindow: number;
  private readonly adaptiveSensitivity: number;
  private readonly confidenceDecayRate: number;
  private readonly adaptiveVolScale: number;
  private readonly confidenceMultiplier: number;

  private lastDirection: SlopeDirection = SlopeDirection.Flat;
  private candidateDirection: SlopeDirection | null = null;
  private stableCount = 0;
  private persistenceSteps = 0;
  private lastDebug: SlopeSignAnalyzerDebug | null = null;

  constructor(options: SlopeSignAnalyzerOptions) {
    if (!options)
      throw new Error('SlopeSignAnalyzer requires explicit options.');

    this.slopeWindow = options.slopeWindow;
    this.minSlopeMagnitude = options.minSlopeMagnitude;
    this.hysteresisCount = options.hysteresisCount;
    this.adaptive = options.adaptive;
    this.adaptiveMinWindow = options.adaptiveMinWindow;
    this.adaptiveMaxWindow = options.adaptiveMaxWindow;
    this.adaptiveSensitivity = options.adaptiveSensitivity;
    this.confidenceDecayRate = options.confidenceDecayRate;
    this.adaptiveVolScale = options.adaptiveVolScale;
    this.confidenceMultiplier = Math.max(0, options.confidenceMultiplier ?? 1);
  }

  public getDebugSnapshot(): SlopeSignAnalyzerDebug | null {
    if (!this.lastDebug)
      return null;

    return { ...this.lastDebug };
  }

  private computeSlope(values: number[]): number {
    if (values.length < 2)
      return 0;

    return (values.at(-1)! - values[0]!) / (values.length - 1);
  }

  private getDirection(slope: number): SlopeDirection {
    if (Math.abs(slope) < this.minSlopeMagnitude)
      return SlopeDirection.Flat;

    return slope > 0 ? SlopeDirection.Up : SlopeDirection.Down;
  }

  private computeAdaptiveWindow(): number {
    if (!this.adaptive || this.history.length < this.slopeWindow)
      return this.slopeWindow;

    const recent = this.history.slice(-this.slopeWindow);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    const normalized = Math.min(1, (stdDev / this.adaptiveVolScale) * this.adaptiveSensitivity);

    const adaptiveSize = Math.round(
      this.adaptiveMaxWindow - normalized * (this.adaptiveMaxWindow - this.adaptiveMinWindow)
    );

    return Math.max(this.adaptiveMinWindow, Math.min(this.adaptiveMaxWindow, adaptiveSize));
  }

  public update(score: number): TradeSignalAnalyzerResult {
    this.history.push(score);

    const currentWindow = this.computeAdaptiveWindow();
    const maxHistory = Math.max(this.adaptiveMaxWindow, currentWindow) * 2;
    if (this.history.length > maxHistory)
      this.history.splice(0, this.history.length - maxHistory);

    if (this.history.length < currentWindow) {
      this.lastDebug = {
        reason: 'insufficient_history',
        currentWindow,
        slope: 0,
        direction: SlopeDirection.Flat,
        previousDirection: this.lastDirection,
        lastDirection: this.lastDirection,
        candidateDirection: this.candidateDirection,
        previousCandidateDirection: this.candidateDirection,
        stableCount: this.stableCount,
        baseConfidence: 0,
        boostedConfidence: 0,
        persistenceSteps: this.persistenceSteps,
        flipTriggered: false
      };

      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    const recent = this.history.slice(-currentWindow);
    const slope = this.computeSlope(recent);
    const direction = this.getDirection(slope);

    const previousDirection = this.lastDirection;
    const previousCandidateDirection = this.candidateDirection;

    const baseConfidence = Math.min(1, Math.abs(slope) / (this.minSlopeMagnitude * 5));
    let confidence = baseConfidence;

    const recordDebug = (
      reason: string,
      boostedConfidence: number,
      flipTriggered: boolean
    ) => {
      this.lastDebug = {
        reason,
        currentWindow,
        slope,
        direction,
        previousDirection,
        lastDirection: this.lastDirection,
        candidateDirection: this.candidateDirection,
        previousCandidateDirection,
        stableCount: this.stableCount,
        baseConfidence,
        boostedConfidence,
        persistenceSteps: this.persistenceSteps,
        flipTriggered
      };
    };

    if (direction === SlopeDirection.Flat) {
      this.stableCount = 0;
      this.candidateDirection = null;
      this.persistenceSteps = 0;

      recordDebug('flat', 0, false);
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    if (this.hysteresisCount <= 0) {
      const multipliedConfidence = Math.min(1, confidence * this.confidenceMultiplier);
      this.lastDirection = direction;
      this.candidateDirection = null;
      this.stableCount = 0;
      this.persistenceSteps = 0;

      recordDebug('hysteresis_disabled', multipliedConfidence, true);

      const signal = direction === SlopeDirection.Up ? TradeSignal.Buy : TradeSignal.Sell;
      return { tradeSignal: signal, confidence: multipliedConfidence };
    }

    if (direction === this.lastDirection) {
      this.stableCount = 0;
      this.candidateDirection = null;
      this.persistenceSteps++;

      const sustainThreshold = this.minSlopeMagnitude * 1.25;
      if (Math.abs(slope) < sustainThreshold) {
        confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
      }

      recordDebug('same_direction', confidence, false);
      return { tradeSignal: TradeSignal.Neutral, confidence };
    }

    if (this.candidateDirection === direction) {
      this.stableCount++;
    } else {
      this.candidateDirection = direction;
      this.stableCount = 1;
    }

    this.persistenceSteps = 0;

    if (this.stableCount >= this.hysteresisCount) {
      this.lastDirection = direction;
      this.stableCount = 0;
      this.candidateDirection = null;
      this.persistenceSteps = 0;

      const multipliedConfidence = Math.min(1, confidence * this.confidenceMultiplier);

      recordDebug('flip_confirmed', multipliedConfidence, true);

      return direction === SlopeDirection.Up
        ? { tradeSignal: TradeSignal.Buy, confidence: multipliedConfidence }
        : { tradeSignal: TradeSignal.Sell, confidence: multipliedConfidence };
    }

    recordDebug('awaiting_confirmation', confidence, false);
    return { tradeSignal: TradeSignal.Neutral, confidence };
  }
}
