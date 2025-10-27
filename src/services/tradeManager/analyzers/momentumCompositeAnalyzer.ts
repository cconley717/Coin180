import type { MomentumCompositeAnalyzerOptions } from "../core/options.js";
import { TradeSignal, type TradeSignalAnalyzerResult } from "../core/types.js";
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

    private pendingSignal: TradeSignal = TradeSignal.Neutral; // candidate direction awaiting confirmation
    private lastSignal: TradeSignal = TradeSignal.Neutral;     // last confirmed direction
    private hysteresisBuffer = 0;
    private persistenceSteps = 0;                              // counts consecutive intent ticks

    private readonly wilderMomentumAnalyzer: WilderMomentumAnalyzer;

    constructor(options: MomentumCompositeAnalyzerOptions) {
        if (!options)
            throw new Error('MomentumCompositeAnalyzer requires explicit options.');

        this.rsiPeriod = options.rsiPeriod;
        this.zWindow = options.zWindow;

        this.buyThreshold = options.buyThreshold;
        this.sellThreshold = options.sellThreshold;

        // 🔹 Sanity checks for thresholds
        if (!(this.sellThreshold < 0 && this.buyThreshold > 0)) {
            throw new Error(`MomentumCompositeAnalyzer: buy/sell thresholds must straddle 0 (sell < 0 < buy). Received sell=${this.sellThreshold}, buy=${this.buyThreshold}`);
        }
        if (this.buyThreshold > 1 || this.sellThreshold < -1) {
            throw new Error(`MomentumCompositeAnalyzer: thresholds must be within [-1, 1]. Received sell=${this.sellThreshold}, buy=${this.buyThreshold}`);
        }

        this.hysteresisCount = options.hysteresisCount;

        // 🔹 Store raw weights; we will normalize per-tick for predictable behavior
        this.rsiWeight = options.rsiWeight;
        this.zWeight = options.zWeight;

        this.adaptive = options.adaptive;
        this.adaptiveMinWindow = options.adaptiveMinWindow;
        this.adaptiveMaxWindow = options.adaptiveMaxWindow;
        this.adaptiveSensitivity = options.adaptiveSensitivity;
        this.adaptiveVolScale = options.adaptiveVolScale; // replaces hard-coded 50
        this.confidenceDecayRate = options.confidenceDecayRate;

        this.wilderMomentumAnalyzer = new WilderMomentumAnalyzer(this.rsiPeriod);
    }

    private computeAdaptiveZWindow(): number {
        if (!this.adaptive || this.history.length < this.zWindow)
            return this.zWindow;

        const recent = this.history.slice(-this.zWindow);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        // 🔹 Use configurable volatility scale
        const normalized = Math.min(1, (stdDev / this.adaptiveVolScale) * this.adaptiveSensitivity);
        const adaptiveSize = Math.round(
            this.adaptiveMaxWindow - normalized * (this.adaptiveMaxWindow - this.adaptiveMinWindow)
        );

        return Math.max(this.adaptiveMinWindow, Math.min(this.adaptiveMaxWindow, adaptiveSize));
    }

    private computeZScore(data: number[]): number | null {
        const zWindow = this.computeAdaptiveZWindow();

        if (data.length < zWindow)
            return null;

        const recent = data.slice(-zWindow);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(Math.max(variance, 1e-6));
        const latest = data.at(-1)!;
        const z = (latest - mean) / stdDev;

        const result = Math.max(-1, Math.min(1, z / 3));

        return result;
    }

    private applyHysteresis(newSignal: TradeSignal): TradeSignal {
        // 🔹 Reset progress on neutral to require consecutive evidence
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
            this.lastSignal = newSignal;          // confirm flip
            this.hysteresisBuffer = 0;
            this.pendingSignal = TradeSignal.Neutral;
            this.persistenceSteps = 0;            // reset persistence on confirmation

            return newSignal;
        }

        return TradeSignal.Neutral;
    }

    public update(score: number): TradeSignalAnalyzerResult {
        // 🔹 Maintain rolling history sized to current adaptive Z window
        this.history.push(score);

        const currentZWindow = this.computeAdaptiveZWindow();
        const maxHistory = Math.max(this.rsiPeriod, currentZWindow) * 2;
        if (this.history.length > maxHistory)
            this.history.splice(0, this.history.length - maxHistory);

        // 🔹 Wilder RSI (normalized -1..1)
        const rsiOut = this.wilderMomentumAnalyzer.update(score);
        if (!rsiOut)
            return { tradeSignal: TradeSignal.Neutral, confidence: 0 };

        const rsi = rsiOut.rsiNorm;

        // 🔹 Z-Score (normalized)
        const z = this.computeZScore(this.history);
        if (z === null)
            return { tradeSignal: TradeSignal.Neutral, confidence: 0 };

        // 🔹 Normalize weights to keep composite ∈ [-1, 1] predictably
        const wSum = this.rsiWeight + this.zWeight;
        const wRSI = wSum > 0 ? this.rsiWeight / wSum : 0.5;
        const wZ = wSum > 0 ? this.zWeight / wSum : 0.5;

        const composite = wRSI * rsi + wZ * z;

        // 🔹 Intent signal (pre-hysteresis)
        let intent: TradeSignal = TradeSignal.Neutral;
        if (composite >= this.buyThreshold)
            intent = TradeSignal.Buy;
        else if (composite <= this.sellThreshold)
            intent = TradeSignal.Sell;

        // 🔹 Apply hysteresis (consecutive evidence only)
        const tradeSignal = this.applyHysteresis(intent);

        // 🔹 Base confidence from composite magnitude
        let confidence = Math.min(1, Math.abs(composite));

        // 🔹 Decay confidence when intent persists in the same direction (regardless of emitted signal)
        if (intent !== TradeSignal.Neutral && intent === this.lastSignal) {
            this.persistenceSteps++;
            confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
        } else if (intent !== TradeSignal.Neutral) {
            // New or changed intent: restart persistence
            this.persistenceSteps = 1;
            confidence *= Math.exp(-this.confidenceDecayRate * this.persistenceSteps);
        } else {
            // No directional intent
            this.persistenceSteps = 0;
        }

        // 🔹 Neutral emits zero confidence (consistent with SlopeSignAnalyzer choice)
        if (tradeSignal === TradeSignal.Neutral)
            return { tradeSignal: TradeSignal.Neutral, confidence: 0 };

        return { tradeSignal, confidence };
    }
}
