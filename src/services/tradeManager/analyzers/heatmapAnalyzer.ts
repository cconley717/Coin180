import type { HeatmapAnalyzerResult, BufferReader } from '../core/types.js';
import {
  autoTuneMinSaturationPass, computePercentages, computeScore, computeShadeCutoffs, detectUniformShades,
  loadBlurredImage, loadRawImage, makeBufferReader, mergeSmall, pass1CollectLightness, pass2Classify
} from '../core/helpers.js';
import type { HeatmapAnalyzerOptions } from '../core/options.js';

export class HeatmapAnalyzer {
  private readonly options: HeatmapAnalyzerOptions;

  constructor(options: HeatmapAnalyzerOptions) {
    this.options = options;
  }

  public async analyze(input: Buffer): Promise<HeatmapAnalyzerResult> {
    // Read original as raw RGBA
    const { data, width, height, ch } = await loadRawImage(input);

    // Blurred buffer for more stable quantiles
    const blurData = await loadBlurredImage(input, this.options.thresholdBlurSigma);

    // Readers
    const idxOf = (x: number, y: number) => (y * width + x) * ch;
    const getRGBAOrig: BufferReader = makeBufferReader(idxOf);
    const getRGBABlur: BufferReader = makeBufferReader(idxOf); // same ch (raw/blur both RGBA)

    // PASS 0 (no other changes)
    this.options.minSaturation = autoTuneMinSaturationPass(
      blurData, width, height, this.options, getRGBABlur
    );

    // PASS 1 (no other changes)
    const { greenL, redL, neutral, candidates } = pass1CollectLightness(
      blurData, width, height, this.options, getRGBABlur
    );

    // ---------- Compute shade cutoffs (b1,b2) per family ----------
    const { gB1, gB2, rB1, rB2 } = computeShadeCutoffs(greenL, redL, this.options);

    // Uniform (near single-shade) detection (preserved)
    const { forceGreenShade, forceRedShade } = detectUniformShades(greenL, redL, this.options);

    // ---------- PASS 2: classify shades on original pixels (with optional neighbor majority) ----------
    const { counts, rawCounts } = pass2Classify({
      data,
      width,
      height,
      ch,
      options: this.options,
      countsSeed: { neutral, analyzedPixels: candidates },
      cuts: { gB1, gB2, rB1, rB2, forceGreenShade, forceRedShade },
      reader: getRGBAOrig,
    });

    // ---------- Minimum shade share merging (preserved) ----------
    mergeSmall(counts.green, this.options.minShadeShare);
    mergeSmall(counts.red, this.options.minShadeShare);

    // ---------- Percentages (preserved) ----------
    const percentages = computePercentages(counts);

    // ---------- Scoring: direction Ã— intensity Ã— coverage (preserved) ----------
    const { score, debug } = computeScore(counts, this.options);

    return {
      counts,
      rawCounts,
      percentages,
      thresholds: {
        green: { b1: gB1, b2: gB2 },
        red: { b1: rB1, b2: rB2 },
      },
      debug: {
        ...debug,
        tunedMinSaturation: this.options.minSaturation,
        forcedGreenShade: forceGreenShade,
        forcedRedShade: forceRedShade,
      },
      score,
    };
  }
}
