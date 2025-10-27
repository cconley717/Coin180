import type {
  HeatmapAnalyzerResult,
  BufferReader,
  HeatmapAnalyzerDebug
} from '../core/types.js';
import type { HeatmapAnalyzerOptions } from '../core/options.js';
import {
  autoTuneMinSaturationPass,
  computePercentages,
  computeScore,
  computeShadeCutoffs,
  detectUniformShades,
  loadBlurredImage,
  loadRawImage,
  makeBufferReader,
  mergeSmall,
  pass1CollectLightness,
  pass2Classify
} from '../core/helpers.js';

export class HeatmapAnalyzer {
  private readonly options: HeatmapAnalyzerOptions;
  private lastDebug: HeatmapAnalyzerDebug | null = null;

  constructor(options: HeatmapAnalyzerOptions) {
    this.options = options;
  }

  public getDebugSnapshot(): HeatmapAnalyzerDebug | null {
    if (!this.lastDebug)
      return null;

    return { ...this.lastDebug };
  }

  public async analyze(input: Buffer): Promise<HeatmapAnalyzerResult> {
    const { data, width, height, ch } = await loadRawImage(input);
    const blurData = await loadBlurredImage(input, this.options.thresholdBlurSigma);

    const idxOf = (x: number, y: number) => (y * width + x) * ch;
    const getRGBAOrig: BufferReader = makeBufferReader(idxOf);
    const getRGBABlur: BufferReader = makeBufferReader(idxOf);

    this.options.minSaturation = autoTuneMinSaturationPass(
      blurData,
      width,
      height,
      this.options,
      getRGBABlur
    );

    const { greenL, redL, neutral, candidates } = pass1CollectLightness(
      blurData,
      width,
      height,
      this.options,
      getRGBABlur
    );

    const { gB1, gB2, rB1, rB2 } = computeShadeCutoffs(greenL, redL, this.options);
    const { forceGreenShade, forceRedShade } = detectUniformShades(greenL, redL, this.options);

    const { counts, rawCounts } = pass2Classify({
      data,
      width,
      height,
      ch,
      options: this.options,
      countsSeed: { neutral, analyzedPixels: candidates },
      cuts: { gB1, gB2, rB1, rB2, forceGreenShade, forceRedShade },
      reader: getRGBAOrig
    });

    mergeSmall(counts.green, this.options.minShadeShare);
    mergeSmall(counts.red, this.options.minShadeShare);

    const percentages = computePercentages(counts);
    const { sentimentScore, debug } = computeScore(counts, this.options);

    this.lastDebug = {
      direction: debug.direction,
      intensity: debug.intensity,
      coverage: debug.coverage,
      minSaturationTuned: this.options.minSaturation,
      forcedGreenShade: forceGreenShade ?? null,
      forcedRedShade: forceRedShade ?? null
    };

    return {
      counts,
      rawCounts,
      percentages,
      thresholds: {
        green: { b1: gB1, b2: gB2 },
        red: { b1: rB1, b2: rB2 }
      },
      sentimentScore
    };
  }
}
