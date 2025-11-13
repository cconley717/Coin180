import type { Shade } from './types.js';

export interface DeltaFilterAnalyzerOptions {
  maxJump: number; // Max allowed OUTPUT step per update (post-smoothing)
  alpha: number; // Smoothing factor (0..1]
  freezeThreshold: number; // Minimum effective delta (with residual) to move
}

export interface SlopeSignAnalyzerOptions {
  slopeWindow: number;
  minSlopeMagnitude: number;
  hysteresisCount: number;
  adaptive: boolean;
  adaptiveMinWindow: number;
  adaptiveMaxWindow: number;
  adaptiveSensitivity: number;
  confidenceDecayRate: number;
  adaptiveVolScale: number; // dY"1 New: scale used to normalize stdDev for adaptivity
  confidenceMultiplier: number;
  confidenceBuyThreshold: number; // Minimum confidence required for buy signal (0-1)
  confidenceSellThreshold: number; // Minimum confidence required for sell signal (0-1)
}

export interface MomentumCompositeAnalyzerOptions {
  rsiPeriod: number;
  zWindow: number;
  momentumBuyThreshold: number;
  momentumSellThreshold: number;
  hysteresisCount: number;
  rsiWeight: number;
  zWeight: number;
  adaptive: boolean;
  adaptiveMinWindow: number;
  adaptiveMaxWindow: number;
  adaptiveSensitivity: number;
  adaptiveVolScale: number; // dY"1 new: scale for volatility normalization
  confidenceDecayRate: number;
  confidenceBuyThreshold: number; // Minimum confidence required for buy signal (0-1)
  confidenceSellThreshold: number; // Minimum confidence required for sell signal (0-1)
}

export interface TradeSignalAnalyzerOptions {
  windowSize: number; // number of ticks to remember
  consensusBuyThreshold: number; // confidence strength required for a buy (0,1]
  consensusSellThreshold: number; // confidence strength required for a sell [-1,0)
  fusionMode: 'weighted' | 'unanimous'; // 'weighted' = confidence-weighted voting, 'unanimous' = both slope and momentum must agree
  sentimentBuyThreshold: number; // sentiment score threshold for buy signals (negative, e.g., -50)
  sentimentSellThreshold: number; // sentiment score threshold for sell signals (positive, e.g., 50)
}

export interface TradeControllerOptions {
  url: string;
  captureInterval: number;
  recordsDirectoryPath: string;
  identifier: string; // unique name per controller instance
  isLoggingEnabled: boolean; // toggles per-tick JSON logging
  heatmapAnalyzerAgent?: 'nodejs' | 'python'; // heatmap analyzer implementation to use ('nodejs' or 'python', defaults to 'nodejs')
  deltaFilterAnalyzerOptions: DeltaFilterAnalyzerOptions;
  slopeSignAnalyzerOptions: SlopeSignAnalyzerOptions;
  momentumCompositeAnalyzerOptions: MomentumCompositeAnalyzerOptions;
  tradeSignalAnalyzerOptions: TradeSignalAnalyzerOptions;
  heatmapAnalyzerOptions: HeatmapAnalyzerOptions;
}

export interface HeatmapAnalyzerOptions {
  pixelStep: number;
  minSaturation: number;
  minValue: number;
  autoTuneMinSaturation: boolean;
  autoTuneSPercentile: number;
  autoTuneSMinFloor: number;
  redHueLowMax: number;
  greenHueMin: number;
  greenHueMax: number;
  thresholdBlurSigma: number;
  collapseEps: number;
  collapseWiden: number;
  uniformDetect: boolean;
  uniformSpreadMax: number;
  uniformLightL: number;
  uniformDarkL: number;
  neighborFilter: boolean;
  neighborAgreeMin: number;
  weights: Record<Shade, number>;
  minShadeShare: number;
  shadeGamma: number;
  coverageFloor: number;
}
