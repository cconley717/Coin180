import type { TradeSignalAnalyzerOptions } from '../core/options.js';
import {
  TradeSignal,
  type TradeSignalAnalyzerInput,
  type TradeSignalAnalyzerResult,
  type TradeSignalFusionDebug,
} from '../core/types.js';

export class TradeSignalAnalyzer {
  private readonly windowSize: number;
  private readonly buyThreshold: number;
  private readonly sellThreshold: number;
  private readonly fusionMode: 'weighted' | 'unanimous';
  private readonly sentimentBuyThreshold: number;
  private readonly sentimentSellThreshold: number;

  private readonly history: TradeSignalAnalyzerInput[] = [];
  private lastDebug: TradeSignalFusionDebug | null = null;
  private lastEmittedSignal: TradeSignal = TradeSignal.Neutral;

  constructor(options: TradeSignalAnalyzerOptions) {
    if (!options) throw new Error('TradeSignalAnalyzer requires explicit options.');

    this.windowSize = Math.max(1, options.windowSize);
    this.buyThreshold = options.buyThreshold;
    this.sellThreshold = options.sellThreshold;
    this.fusionMode = options.fusionMode;
    this.sentimentBuyThreshold = options.sentimentBuyThreshold;
    this.sentimentSellThreshold = options.sentimentSellThreshold;

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
    if (!(this.sentimentBuyThreshold < 0 && this.sentimentSellThreshold > 0)) {
      throw new Error(
        `TradeSignalAnalyzer: sentiment thresholds must straddle 0 (buy < 0 < sell). ` +
          `Got buy=${this.sentimentBuyThreshold}, sell=${this.sentimentSellThreshold}`
      );
    }
  }

  public getDebugSnapshot(): TradeSignalFusionDebug | null {
    if (!this.lastDebug) return null;

    return { ...this.lastDebug };
  }

  public update(tradeSignalAnalyzerInput: TradeSignalAnalyzerInput): TradeSignalAnalyzerResult {
    const currentFusion = this.computeTickFusion(tradeSignalAnalyzerInput);

    this.history.push(tradeSignalAnalyzerInput);
    if (this.history.length > this.windowSize) this.history.splice(0, this.history.length - this.windowSize);

    const consensusResult = this.computeConsensus();
    if (!consensusResult) {
      return this.createNeutralResult(currentFusion, 'no_confidence');
    }

    const { consensusScore, totalScore, totalConfidence } = consensusResult;
    const consensusSignal = this.determineConsensusSignal(consensusScore);
    
    return this.handleEdgeDetection(consensusSignal, consensusScore, totalScore, totalConfidence, currentFusion, tradeSignalAnalyzerInput.sentimentScore);
  }

  private computeConsensus(): { consensusScore: number; totalScore: number; totalConfidence: number } | null {
    let totalScore = 0;
    let totalConfidence = 0;

    for (const entry of this.history) {
      const { tickScore, tickConfidence } = this.computeTickFusion(entry);
      totalScore += tickScore * tickConfidence;
      totalConfidence += tickConfidence;
    }

    if (totalConfidence === 0) return null;

    return { consensusScore: totalScore / totalConfidence, totalScore, totalConfidence };
  }

  private determineConsensusSignal(consensusScore: number): TradeSignal {
    if (consensusScore >= this.buyThreshold) return TradeSignal.Buy;
    if (consensusScore <= this.sellThreshold) return TradeSignal.Sell;
    return TradeSignal.Neutral;
  }

  private handleEdgeDetection(
    consensusSignal: TradeSignal,
    consensusScore: number,
    totalScore: number,
    totalConfidence: number,
    currentFusion: { tickScore: number; tickConfidence: number },
    sentimentScore: number
  ): TradeSignalAnalyzerResult {
    // Check sentiment thresholds before edge detection
    if (consensusSignal === TradeSignal.Buy && sentimentScore > this.sentimentBuyThreshold) {
      this.updateDebug('sentiment_buy_threshold_not_met', TradeSignal.Neutral, 0, totalScore, totalConfidence, consensusScore, currentFusion);
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }
    if (consensusSignal === TradeSignal.Sell && sentimentScore < this.sentimentSellThreshold) {
      this.updateDebug('sentiment_sell_threshold_not_met', TradeSignal.Neutral, 0, totalScore, totalConfidence, consensusScore, currentFusion);
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }

    // Edge detection: only emit signal if transitioning from neutral to signal
    const shouldEmitSignal = this.lastEmittedSignal === TradeSignal.Neutral && 
                            consensusSignal !== TradeSignal.Neutral;
    
    if (shouldEmitSignal) {
      this.lastEmittedSignal = consensusSignal;
      const confidence = Math.min(1, Math.abs(consensusScore));
      this.updateDebug('signal_emitted_once', consensusSignal, confidence, totalScore, totalConfidence, consensusScore, currentFusion);
      return { tradeSignal: consensusSignal, confidence };
    } else {
      // Reset state if consensus drops back to neutral
      if (consensusSignal === TradeSignal.Neutral) {
        this.lastEmittedSignal = TradeSignal.Neutral;
      }
      this.updateDebug(
        consensusSignal !== TradeSignal.Neutral ? 'consensus_held' : 'neutral',
        TradeSignal.Neutral,
        0,
        totalScore,
        totalConfidence,
        consensusScore,
        currentFusion
      );
      return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
    }
  }

  private createNeutralResult(
    currentFusion: { tickScore: number; tickConfidence: number },
    reason: string
  ): TradeSignalAnalyzerResult {
    this.lastDebug = {
      reason,
      windowSamples: this.history.length,
      totalScore: 0,
      totalConfidence: 0,
      consensusScore: 0,
      buyThreshold: this.buyThreshold,
      sellThreshold: this.sellThreshold,
      finalSignal: TradeSignal.Neutral,
      finalConfidence: 0,
      tickScore: currentFusion.tickScore,
      tickConfidence: currentFusion.tickConfidence,
    };
    return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
  }

  private updateDebug(
    reason: string,
    finalSignal: TradeSignal,
    finalConfidence: number,
    totalScore: number,
    totalConfidence: number,
    consensusScore: number,
    currentFusion: { tickScore: number; tickConfidence: number }
  ): void {
    this.lastDebug = {
      reason,
      windowSamples: this.history.length,
      totalScore,
      totalConfidence,
      consensusScore,
      buyThreshold: this.buyThreshold,
      sellThreshold: this.sellThreshold,
      finalSignal,
      finalConfidence,
      tickScore: currentFusion.tickScore,
      tickConfidence: currentFusion.tickConfidence,
    };
  }

  private computeTickFusion(entry: TradeSignalAnalyzerInput): { tickScore: number; tickConfidence: number } {
    const slope = this.signalToNumeric(entry.slopeSignTradeSignal);
    const momentum = this.signalToNumeric(entry.momentumCompositeTradeSignal);

    const cSlope = entry.slopeSignTradeSignal.confidence ?? 0;
    const cMomentum = entry.momentumCompositeTradeSignal.confidence ?? 0;

    // Unanimous mode: both slope and momentum must signal the same non-neutral direction
    if (this.fusionMode === 'unanimous') {
      const allBuy = slope === 1 && momentum === 1;
      const allSell = slope === -1 && momentum === -1;
      
      // If not unanimous, return neutral (0 score, 0 confidence)
      if (!allBuy && !allSell) {
        return { tickScore: 0, tickConfidence: 0 };
      }
    }

    // Weighted mode: confidence-weighted average (original behavior)
    const totalConfidence = cSlope + cMomentum;

    const tickScore =
      totalConfidence > 0 ? (slope * cSlope + momentum * cMomentum) / totalConfidence : 0;

    const tickConfidence = totalConfidence / 2;

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
