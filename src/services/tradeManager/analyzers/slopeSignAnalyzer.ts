import type { SlopeSignAnalyzerOptions } from "../core/options.js";
import { TradeSignal, type TradeSignalAnalyzerResult } from "../core/types.js";

export enum SlopeDirection {
    Up = 'up',
    Down = 'down',
    Flat = 'flat',
}

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
    private candidateDirection: SlopeDirection | null = null;   // ðŸ”¹ New: require consecutive same-direction evidence
    private stableCount = 0;
    private persistenceSteps = 0;

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
        this.adaptiveVolScale = options.adaptiveVolScale; // ðŸ”¹ Default preserves prior behavior
        this.confidenceMultiplier = options.confidenceMultiplier;
    }

    private computeSlope(values: number[]): number {
        if (values.length < 2)
            return 0;

        // ðŸ”¹ Simpler & faster: average of diffs == (last - first) / (n - 1)
        const result = (values.at(-1)! - values[0]!) / (values.length - 1);

        return result;
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

        // ðŸ”¹ Use configurable scale for normalization (instead of hard-coded 50)
        const normalized = Math.min(1, (stdDev / this.adaptiveVolScale) * this.adaptiveSensitivity);

        const adaptiveSize = Math.round(
            this.adaptiveMaxWindow - normalized * (this.adaptiveMaxWindow - this.adaptiveMinWindow)
        );

        return Math.max(this.adaptiveMinWindow, Math.min(this.adaptiveMaxWindow, adaptiveSize));
    }

    public update(score: number): TradeSignalAnalyzerResult {
        this.history.push(score);

        // ðŸ”¹ Use current adaptive window to set a dynamic history cap
        const currentWindow = this.computeAdaptiveWindow();
        const maxHistory = Math.max(this.adaptiveMaxWindow, currentWindow) * 2;
        if (this.history.length > maxHistory)
            this.history.splice(0, this.history.length - maxHistory);

        if (this.history.length < currentWindow)
            return { tradeSignal: TradeSignal.Neutral, confidence: 0 };

        const recent = this.history.slice(-currentWindow);
        const slope = this.computeSlope(recent);
        const direction = this.getDirection(slope);

        // ðŸ”¹ Base confidence from slope magnitude
        const baseConfidence = Math.min(1, Math.abs(slope) / (this.minSlopeMagnitude * 5));
        let confidence = baseConfidence;

        // ðŸ”¹ Flat: reset hysteresis state and do not dilute trade signal analyzer confidence
        if (direction === SlopeDirection.Flat) {
            this.stableCount = 0;
            this.candidateDirection = null;
            this.persistenceSteps = 0;

            return { tradeSignal: TradeSignal.Neutral, confidence: 0 };
        }

        // ðŸ”¹ If hysteresis disabled, flip instantly
        if (this.hysteresisCount <= 0) {
            const signal = direction === SlopeDirection.Up ? TradeSignal.Buy : TradeSignal.Sell;
            this.lastDirection = direction;
            this.candidateDirection = null;
            this.stableCount = 0;
            this.persistenceSteps = 0;

            return { tradeSignal: signal, confidence: confidence };
        }

        // ðŸ”¹ Same as confirmed direction: maintain state; optionally decay only when slope is weak
        if (direction === this.lastDirection) {
            this.stableCount = 0;              // no pending flip in progress
            this.candidateDirection = null;
            this.persistenceSteps++;

            const sustainThreshold = this.minSlopeMagnitude * 1.25;
            if (Math.abs(slope) < sustainThreshold) {
                confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
            }

            // Keep emitting Neutral while trend persists (trade signal analyzer aggregates confidence via momentum/MA)
            return { tradeSignal: TradeSignal.Neutral, confidence: confidence };
        }

        // ðŸ”¹ Different from confirmed direction: require consecutive evidence
        if (this.candidateDirection === direction) {
            this.stableCount++;
        } else {
            this.candidateDirection = direction;
            this.stableCount = 1;
        }

        this.persistenceSteps = 0; // new attempt to flip; reset persistence

        if (this.stableCount >= this.hysteresisCount) {
            // Confirmed flip
            this.lastDirection = direction;
            this.stableCount = 0;
            this.candidateDirection = null;
            this.persistenceSteps = 0;

            const multipliedConfidence = Math.min(1, confidence * this.confidenceMultiplier);

            if (direction === SlopeDirection.Up)
                return { tradeSignal: TradeSignal.Buy, confidence: multipliedConfidence };
            else
                return { tradeSignal: TradeSignal.Sell, confidence: multipliedConfidence };
        }

        // Not enough consecutive evidence yet â†’ Neutral, but keep confidence to reflect forming pressure
        return { tradeSignal: TradeSignal.Neutral, confidence: confidence };
    }
}


