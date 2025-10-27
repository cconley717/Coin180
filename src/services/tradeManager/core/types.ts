import type { HeatmapAnalyzerOptions } from "./options.js";

export type Shade = 'light' | 'medium' | 'dark';

export const FAMILY_GREEN = 'green';
export const FAMILY_RED = 'red';
export const FAMILY_NEUTRAL = 'neutral';
export type Family = typeof FAMILY_GREEN | typeof FAMILY_RED | typeof FAMILY_NEUTRAL;

export type RGBA = readonly [number, number, number, number];
export type BufferReader = (buf: Buffer, x: number, y: number) => RGBA;

export type ShadeTallies = { light: number; medium: number; dark: number; total: number };

export enum TradeSignal {
  Buy = 'buy',
  Sell = 'sell',
  Neutral = 'neutral'
}

export interface TradeSignalAnalyzerResult {
  tradeSignal: TradeSignal;
  confidence: number;
}

export interface TradeSignalAnalyzerInput {
  slopeSignTradeSignal: TradeSignalAnalyzerResult;
  momentumCompositeTradeSignal: TradeSignalAnalyzerResult;
  movingAverageTradeSignal: TradeSignalAnalyzerResult;
}

export interface HeatmapAnalyzerResult {
  counts: {
    green: Record<Shade, number> & { total: number };
    red: Record<Shade, number> & { total: number };
    neutral: number;
    analyzedPixels: number;      // candidates after S/V gating (pre-neighbor)
  };
  rawCounts: {
    // pre-merge shade counts (for debugging/visibility)
    green: Record<Shade, number> & { total: number };
    red: Record<Shade, number> & { total: number };
  };
  percentages: {
    green: Record<Shade, number>;
    red: Record<Shade, number>;
  };
  thresholds: {
    // HSL Lightness cutoffs actually used
    green: { b1: number; b2: number };
    red: { b1: number; b2: number };
  };
  sentimentScore: number;                 // -100..100
}

export type CountMap = {
  green: ShadeTallies;
  red: ShadeTallies;
  neutral: number;
  analyzedPixels: number;
};

export interface Cuts {
  gB1: number; gB2: number;
  rB1: number; rB2: number;
  forceGreenShade: Shade | null;
  forceRedShade: Shade | null;
}

export interface Pass2Params {
  data: Buffer;
  width: number;
  height: number;
  ch: number;
  options: HeatmapAnalyzerOptions;
  countsSeed: { neutral: number; analyzedPixels: number };
  cuts: Cuts;
  reader: BufferReader;
}

export enum SlopeDirection {
  Up = 'up',
  Down = 'down',
  Flat = 'flat'
}

export interface DeltaFilterDebug {
  rawScore: number;
  previousFiltered: number;
  residualBefore: number;
  residualAfter: number;
  desiredStep: number;
  appliedStep: number;
  froze: boolean;
  maxJumpHit: boolean;
}

export interface HeatmapAnalyzerDebug {
  direction: number;
  intensity: number;
  coverage: number;
  minSaturationTuned: number;
  forcedGreenShade: Shade | null;
  forcedRedShade: Shade | null;
}

export interface SlopeSignAnalyzerDebug {
  reason: string;
  currentWindow: number;
  slope: number;
  direction: SlopeDirection;
  previousDirection: SlopeDirection;
  lastDirection: SlopeDirection;
  candidateDirection: SlopeDirection | null;
  previousCandidateDirection: SlopeDirection | null;
  stableCount: number;
  baseConfidence: number;
  boostedConfidence: number;
  persistenceSteps: number;
  flipTriggered: boolean;
}

export interface MomentumCompositeAnalyzerDebug {
  reason: string;
  adaptiveWindow: number;
  rsiNorm: number | null;
  zScore: number | null;
  composite: number | null;
  intent: TradeSignal;
  confirmedSignal: TradeSignal;
  pendingSignal: TradeSignal;
  hysteresisBuffer: number;
  persistenceSteps: number;
  confidenceBeforeDecay: number | null;
  confidenceAfterDecay: number | null;
}

export interface MovingAverageAnalyzerDebug {
  reason: string;
  adaptiveShort: number;
  adaptiveLong: number;
  currentShortMA: number | null;
  currentLongMA: number | null;
  previousShortMA: number | null;
  previousLongMA: number | null;
  spread: number | null;
  spreadStd: number | null;
  intent: TradeSignal;
  confirmedSignal: TradeSignal;
  pendingSignal: TradeSignal;
  hysteresisBuffer: number;
  persistenceSteps: number;
}

export interface TradeSignalFusionDebug {
  reason: string;
  windowSamples: number;
  totalScore: number;
  totalConfidence: number;
  consensusScore: number;
  buyThreshold: number;
  sellThreshold: number;
  finalSignal: TradeSignal;
  finalConfidence: number;
  tickScore: number;
  tickConfidence: number;
}
