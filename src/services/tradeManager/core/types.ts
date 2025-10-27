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
  debug: {
    direction: number;           // -1..1 (green vs red area)
    intensity: number;           // 0..1 (winner's average shade strength)
    coverage: number;            // 0..1 (colored vs candidates)
    minSaturationTuned: number;  // actual S gate used (after auto-tune)
    forcedGreenShade?: Shade | null;
    forcedRedShade?: Shade | null;
  };
  score: number;                 // -100..100
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
