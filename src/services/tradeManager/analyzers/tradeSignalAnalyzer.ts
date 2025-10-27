import type { TradeSignalAnalyzerOptions } from "../core/options.js";
import {
  TradeSignal,
  type TradeSignalAnalyzerInput,
  type TradeSignalAnalyzerResult
} from "../core/types.js";

export class TradeSignalAnalyzer {
  private readonly windowSize: number;
  private readonly buyThreshold: number;
  private readonly sellThreshold: number;

  private readonly history: TradeSignalAnalyzerInput[] = [];

  constructor(options: TradeSignalAnalyzerOptions) {
    if (!options)
      throw new Error('TradeSignalAnalyzer requires explicit options.');

    const ws = options.windowSize;
    this.windowSize = Math.max(1, ws);

    this.buyThreshold = options.buyThreshold;
    this.sellThreshold = options.sellThreshold;

    // Threshold sanity: must straddle 0 and live in [-1,1]
    if (!(this.sellThreshold < 0 && this.buyThreshold > 0)) {
      throw new Error(
        `TradeSignalAnalyzer: thresholds must straddle 0 (sell < 0 < buy). ` +
        `Got sell=${this.sellThreshold}, buy=${this.buyThreshold}`
      );
    }
    if (this.buyThreshold > 1 || this.sellThreshold < -1) {
      throw new Error(
        `TradeSignalAnalyzer: thresholds must be within [-1, 1]. ` +
        `Got sell=${this.sellThreshold}, buy=${this.buyThreshold}`
      );
    }
  }

  public update(tradeSignalAnalyzerInput: TradeSignalAnalyzerInput): TradeSignalAnalyzerResult {
    // Maintain rolling window
    this.history.push(tradeSignalAnalyzerInput);
    if (this.history.length > this.windowSize) {
      this.history.splice(0, this.history.length - this.windowSize);
    }

    let totalScore = 0;
    let totalConfidence = 0;

    for (const entry of this.history) {
      const { tickScore, tickConfidence } = this.computeTickFusion(entry);

      totalScore += tickScore * tickConfidence;
      totalConfidence += tickConfidence;
    }

    // No usable confidence in the window → neutral
    if (totalConfidence === 0) {
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    const confidence = totalScore / totalConfidence;

    let tradeSignal = TradeSignal.Neutral;

    if (confidence >= this.buyThreshold)
      tradeSignal = TradeSignal.Buy;
    else if (confidence <= this.sellThreshold)
      tradeSignal = TradeSignal.Sell;
    return { tradeSignal, confidence: confidence };
  }

  private computeTickFusion(entry: TradeSignalAnalyzerInput): { tickScore: number; tickConfidence: number } {
    const slope = this.signalToNumeric(entry.slopeSignTradeSignal);
    const momentum = this.signalToNumeric(entry.momentumCompositeTradeSignal);
    const moving = this.signalToNumeric(entry.movingAverageTradeSignal);

    const cSlope = entry.slopeSignTradeSignal.confidence ?? 0;
    const cMomentum = entry.momentumCompositeTradeSignal.confidence ?? 0;
    const cMoving = entry.movingAverageTradeSignal.confidence ?? 0;

    const totalConfidence = cSlope + cMomentum + cMoving;

    const tickScore =
      totalConfidence > 0
        ? (slope * cSlope + momentum * cMomentum + moving * cMoving) / totalConfidence
        : 0;

    // Mean analyzer confidence for this tick (0..1-ish if analyzers use that scale)
    const tickConfidence = totalConfidence / 3;

    return { tickScore, tickConfidence };
  }

  private signalToNumeric(tradeSignalAnalyzerResult: TradeSignalAnalyzerResult): number {
    switch (tradeSignalAnalyzerResult.tradeSignal) {
      case TradeSignal.Buy:
        return 1;
      case TradeSignal.Sell:
        return -1;
      default:
        return 0;
    }
  }
}
