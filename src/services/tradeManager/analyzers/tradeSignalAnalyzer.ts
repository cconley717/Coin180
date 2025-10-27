import type { TradeSignalAnalyzerOptions } from "../core/options.js";
import {
  TradeSignal,
  type TradeSignalAnalyzerInput,
  type TradeSignalAnalyzerResult,
  type TradeSignalFusionDebug
} from "../core/types.js";

export class TradeSignalAnalyzer {
  private readonly windowSize: number;
  private readonly buyThreshold: number;
  private readonly sellThreshold: number;

  private readonly history: TradeSignalAnalyzerInput[] = [];
  private lastDebug: TradeSignalFusionDebug | null = null;

  constructor(options: TradeSignalAnalyzerOptions) {
    if (!options)
      throw new Error('TradeSignalAnalyzer requires explicit options.');

    this.windowSize = Math.max(1, options.windowSize);
    this.buyThreshold = options.buyThreshold;
    this.sellThreshold = options.sellThreshold;

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

  public getDebugSnapshot(): TradeSignalFusionDebug | null {
    if (!this.lastDebug)
      return null;

    return { ...this.lastDebug };
  }

  public update(tradeSignalAnalyzerInput: TradeSignalAnalyzerInput): TradeSignalAnalyzerResult {
    const currentFusion = this.computeTickFusion(tradeSignalAnalyzerInput);

    this.history.push(tradeSignalAnalyzerInput);
    if (this.history.length > this.windowSize)
      this.history.splice(0, this.history.length - this.windowSize);

    let totalScore = 0;
    let totalConfidence = 0;

    for (const entry of this.history) {
      const { tickScore, tickConfidence } = this.computeTickFusion(entry);
      totalScore += tickScore * tickConfidence;
      totalConfidence += tickConfidence;
    }

    if (totalConfidence === 0) {
      this.lastDebug = {
        reason: 'no_confidence',
        windowSamples: this.history.length,
        totalScore,
        totalConfidence,
        consensusScore: 0,
        buyThreshold: this.buyThreshold,
        sellThreshold: this.sellThreshold,
        finalSignal: TradeSignal.Neutral,
        finalConfidence: 0,
        tickScore: currentFusion.tickScore,
        tickConfidence: currentFusion.tickConfidence
      };

      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    const consensusScore = totalScore / totalConfidence;
    let tradeSignal: TradeSignal = TradeSignal.Neutral;

    if (consensusScore >= this.buyThreshold)
      tradeSignal = TradeSignal.Buy;
    else if (consensusScore <= this.sellThreshold)
      tradeSignal = TradeSignal.Sell;

    const confidence = Math.min(1, Math.abs(consensusScore));

    this.lastDebug = {
      reason: tradeSignal === TradeSignal.Neutral ? 'neutral' : 'signal_emitted',
      windowSamples: this.history.length,
      totalScore,
      totalConfidence,
      consensusScore,
      buyThreshold: this.buyThreshold,
      sellThreshold: this.sellThreshold,
      finalSignal: tradeSignal,
      finalConfidence: confidence,
      tickScore: currentFusion.tickScore,
      tickConfidence: currentFusion.tickConfidence
    };

    return { tradeSignal, confidence };
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
