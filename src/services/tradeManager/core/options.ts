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
  minSignalBuyConfidence: number; // Minimum confidence required for buy signal (0-1)
  minSignalSellConfidence: number; // Minimum confidence required for sell signal (0-1)
}

export interface MomentumCompositeAnalyzerOptions {
  rsiPeriod: number;
  zWindow: number;
  buyThreshold: number;
  sellThreshold: number;
  hysteresisCount: number;
  rsiWeight: number;
  zWeight: number;
  adaptive: boolean;
  adaptiveMinWindow: number;
  adaptiveMaxWindow: number;
  adaptiveSensitivity: number;
  adaptiveVolScale: number; // dY"1 new: scale for volatility normalization
  confidenceDecayRate: number;
  minSignalBuyConfidence: number; // Minimum confidence required for buy signal (0-1)
  minSignalSellConfidence: number; // Minimum confidence required for sell signal (0-1)
}

export interface MovingAverageAnalyzerOptions {
  shortWindow: number;
  longWindow: number;
  hysteresisCount: number;
  adaptive: boolean;
  adaptiveMinWindow: number;
  adaptiveMaxWindow: number;
  adaptiveSensitivity: number;
  adaptiveVolScale: number; // dY"1 new: scale used to normalize volatility for adaptivity
  confidenceDecayRate: number;
  minSignalBuyConfidence: number; // Minimum confidence required for buy signal (0-1)
  minSignalSellConfidence: number; // Minimum confidence required for sell signal (0-1)
}

export interface TradeSignalAnalyzerOptions {
  windowSize: number; // number of ticks to remember
  buyThreshold: number; // confidence strength required for a buy (0,1]
  sellThreshold: number; // confidence strength required for a sell [-1,0)
  fusionMode: 'weighted' | 'unanimous'; // 'weighted' = confidence-weighted voting, 'unanimous' = all 3 must agree
}

export interface TradeControllerOptions {
  url: string;
  captureInterval: number;
  recordsDirectoryPath: string;
  identifier: string; // unique name per controller instance
  isLoggingEnabled: boolean; // toggles per-tick JSON logging
  deltaFilterAnalyzerOptions: DeltaFilterAnalyzerOptions;
  slopeSignAnalyzerOptions: SlopeSignAnalyzerOptions;
  momentumCompositeAnalyzerOptions: MomentumCompositeAnalyzerOptions;
  movingAverageAnalyzerOptions: MovingAverageAnalyzerOptions;
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
