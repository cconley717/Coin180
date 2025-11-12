import type { HeatmapAnalyzerOptions } from '../core/options.js';
import sharp from 'sharp';
import {
  type HeatmapAnalyzerResult,
  type BufferReader,
  type HeatmapAnalyzerDebug,
  FAMILY_GREEN,
  FAMILY_NEUTRAL,
  FAMILY_RED,
  type CountMap,
  type Family,
  type Pass2Params,
  type RGBA,
  type Shade,
  type ShadeTallies,
} from '../core/types.js';

export class HeatmapAnalyzer {
  private readonly options: HeatmapAnalyzerOptions;
  private lastDebug: HeatmapAnalyzerDebug | null = null;

  constructor(options: HeatmapAnalyzerOptions) {
    this.options = options;
  }

  public getDebugSnapshot(): HeatmapAnalyzerDebug | null {
    if (!this.lastDebug) return null;

    return { ...this.lastDebug };
  }

  public async analyze(input: Buffer): Promise<HeatmapAnalyzerResult> {
    const { data, width, height, ch } = await this.loadRawImage(input);
    const blurData = await this.loadBlurredImage(input, this.options.thresholdBlurSigma);

    const idxOf = (x: number, y: number) => (y * width + x) * ch;
    const getRGBAOrig: BufferReader = this.makeBufferReader(idxOf);
    const getRGBABlur: BufferReader = this.makeBufferReader(idxOf);

    this.options.minSaturation = this.autoTuneMinSaturationPass(blurData, width, height, this.options, getRGBABlur);

    const { greenL, redL, neutral, candidates } = this.pass1CollectLightness(
      blurData,
      width,
      height,
      this.options,
      getRGBABlur
    );

    const { gB1, gB2, rB1, rB2 } = this.computeShadeCutoffs(greenL, redL, this.options);
    const { forceGreenShade, forceRedShade } = this.detectUniformShades(greenL, redL, this.options);

    const { counts, rawCounts } = this.pass2Classify({
      data,
      width,
      height,
      ch,
      options: this.options,
      countsSeed: { neutral, analyzedPixels: candidates },
      cuts: { gB1, gB2, rB1, rB2, forceGreenShade, forceRedShade },
      reader: getRGBAOrig,
    });

    this.mergeSmall(counts.green, this.options.minShadeShare);
    this.mergeSmall(counts.red, this.options.minShadeShare);

    const percentages = this.computePercentages(counts);
    const { sentimentScore, debug } = this.computeScore(counts, this.options);

    this.lastDebug = {
      direction: debug.direction,
      intensity: debug.intensity,
      coverage: debug.coverage,
      minSaturationTuned: this.options.minSaturation,
      forcedGreenShade: forceGreenShade ?? null,
      forcedRedShade: forceRedShade ?? null,
      backend: 'nodejs',
    };

    return {
        sentimentScore,
      counts,
      rawCounts,
      percentages,
      thresholds: {
        green: { b1: gB1, b2: gB2 },
        red: { b1: rB1, b2: rB2 },
      }
    };
  }

  private makeBufferReader(idxOf: (x: number, y: number) => number): BufferReader {
    return (buf: Buffer, x: number, y: number): RGBA => {
      const i = idxOf(x, y);
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      const a = buf[i + 3];

      return [r!, g!, b!, a!] as const;
    };
  }

  private async loadRawImage(input: Buffer | string) {
    const orig = await sharp(input).raw().ensureAlpha().toBuffer({ resolveWithObject: true });

    return { data: orig.data, width: orig.info.width, height: orig.info.height, ch: orig.info.channels };
  }

  private async loadBlurredImage(input: Buffer | string, sigma: number): Promise<Buffer> {
    const blurred = await sharp(input).blur(sigma).raw().ensureAlpha().toBuffer({ resolveWithObject: true });

    return blurred.data;
  }

  private autoTuneMinSaturationPass(
    src: Buffer,
    width: number,
    height: number,
    opts: HeatmapAnalyzerOptions,
    getRGBAFn: BufferReader
  ) {
    const sSamples: number[] = [];

    for (let y = 0; y < height; y += opts.pixelStep) {
      for (let x = 0; x < width; x += opts.pixelStep) {
        const [r, g, b, a] = getRGBAFn(src, x, y);

        if (a < 8) continue;

        const { s, v } = this.rgbToHsv(r, g, b);

        if (v < opts.minValue) continue;

        sSamples.push(s);
      }
    }

    if (sSamples.length >= 50) {
      sSamples.sort((a, b) => a - b);

      const sP = this.percentile(sSamples, Math.min(0.95, Math.max(0.05, opts.autoTuneSPercentile)));
      const tuned = Math.max(opts.autoTuneSMinFloor, Math.min(opts.minSaturation, sP! * 0.95));

      return tuned;
    }

    return opts.minSaturation;
  }

  private pass1CollectLightness(
    src: Buffer,
    width: number,
    height: number,
    opts: HeatmapAnalyzerOptions,
    getRGBAFn: BufferReader
  ) {
    const greenL: number[] = [];
    const redL: number[] = [];
    let neutral = 0;
    let candidates = 0;

    for (let y = 0; y < height; y += opts.pixelStep) {
      for (let x = 0; x < width; x += opts.pixelStep) {
        const [r, g, b, a] = getRGBAFn(src, x, y);
        const fam = this.familyOf(r, g, b, a, opts);

        if (fam === FAMILY_NEUTRAL) {
          neutral++;
          continue;
        }

        candidates++;

        const L = this.hslLightness(r, g, b);

        if (fam === FAMILY_GREEN) greenL.push(L);
        else redL.push(L);
      }
    }
    return { greenL, redL, neutral, candidates };
  }

  private computeShadeCutoffs(greenL: number[], redL: number[], opts: HeatmapAnalyzerOptions) {
    let [gB1, gB2]: [number, number] = [0.45, 0.7];
    let [rB1, rB2]: [number, number] = [0.45, 0.7];

    greenL.sort((a, b) => a - b);
    redL.sort((a, b) => a - b);

    if (greenL.length >= 10) {
      gB1 = this.percentile(greenL, 0.33)!;
      gB2 = this.percentile(greenL, 0.66)!;
    }

    if (redL.length >= 10) {
      rB1 = this.percentile(redL, 0.33)!;
      rB2 = this.percentile(redL, 0.66)!;
    }

    const widenIfCollapsed = (b1: number, b2: number, arr: number[]) => {
      if (Math.abs(b2 - b1) < opts.collapseEps) {
        const med = this.percentile(arr, 0.5)!;

        b1 = Math.max(0, med - opts.collapseWiden);
        b2 = Math.min(1, med + opts.collapseWiden);
      }

      return [b1, b2] as const;
    };

    [gB1, gB2] = widenIfCollapsed(gB1, gB2, greenL);
    [rB1, rB2] = widenIfCollapsed(rB1, rB2, redL);

    return { gB1, gB2, rB1, rB2 };
  }

  private detectUniformShades(greenL: number[], redL: number[], opts: HeatmapAnalyzerOptions) {
    let forceGreenShade: Shade | null = null;
    let forceRedShade: Shade | null = null;

    const uniformShade = (arr: number[]) => {
      if (!opts.uniformDetect || arr.length < 50) return null;
      else {
        const p05 = this.percentile(arr, 0.05)!;
        const p95 = this.percentile(arr, 0.95)!;

        const spread = p95 - p05;

        if (spread >= opts.uniformSpreadMax) return null;
        else {
          const med = this.percentile(arr, 0.5)!;

          if (med >= opts.uniformLightL) return 'light';
          else if (med <= opts.uniformDarkL) return 'dark';
          else return 'medium';
        }
      }
    };

    const gUniform = uniformShade(greenL);

    if (gUniform) forceGreenShade = gUniform;

    const rUniform = uniformShade(redL);

    if (rUniform) forceRedShade = rUniform;

    return { forceGreenShade, forceRedShade };
  }

  private pass2Classify(p: Pass2Params) {
    const { data, width, height, options, countsSeed, cuts, reader } = p;

    const initSide = (): ShadeTallies => ({ light: 0, medium: 0, dark: 0, total: 0 });

    const counts: CountMap = {
      green: initSide(),
      red: initSide(),
      neutral: countsSeed.neutral,
      analyzedPixels: countsSeed.analyzedPixels,
    };

    const rawCounts: { green: ShadeTallies; red: ShadeTallies } = {
      green: initSide(),
      red: initSide(),
    };

    const hasNeighborAgreement = (x: number, y: number, fam: typeof FAMILY_GREEN | typeof FAMILY_RED): boolean => {
      if (!options.neighborFilter) return true;

      let agree = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;

          const nx = x + dx,
            ny = y + dy;

          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const [nr, ng, nb, na] = reader(data, nx, ny);
          const nf = this.familyOf(nr, ng, nb, na, options);

          if (nf === fam) agree++;
        }
      }

      return agree >= options.neighborAgreeMin;
    };

    const bump = (
      m: { green: ShadeTallies; red: ShadeTallies },
      fam: typeof FAMILY_GREEN | typeof FAMILY_RED,
      shade: Shade
    ) => {
      const side = m[fam];

      side[shade]++;
      side.total++;
    };

    for (let y = 0; y < height; y += options.pixelStep) {
      for (let x = 0; x < width; x += options.pixelStep) {
        const [r, g, b, a] = reader(data, x, y);
        const fam = this.familyOf(r, g, b, a, options);

        if (fam === FAMILY_NEUTRAL) continue;

        if (!hasNeighborAgreement(x, y, fam)) continue;

        const L = this.hslLightness(r, g, b);

        const shade =
          fam === FAMILY_GREEN
            ? (cuts.forceGreenShade ?? this.shadeFromL(L, cuts.gB1, cuts.gB2))
            : (cuts.forceRedShade ?? this.shadeFromL(L, cuts.rB1, cuts.rB2));

        bump(counts, fam, shade);
        bump(rawCounts, fam, shade);
      }
    }

    return { counts, rawCounts };
  }

  private mergeSmall(b: { light: number; medium: number; dark: number; total: number }, minShare: number) {
    if (b.total === 0) return;

    const cut = Math.ceil(b.total * minShare);

    if (b.dark > 0 && b.dark < cut) {
      b.medium += b.dark;
      b.dark = 0;
    }

    if (b.medium > 0 && b.medium < cut) {
      b.light += b.medium;
      b.medium = 0;
    }
  }

  private computePercentages(counts: HeatmapAnalyzerResult['counts']) {
    const pct = (n: number, d: number) => (d ? n / d : 0);

    return {
      green: {
        light: pct(counts.green.light, counts.green.total),
        medium: pct(counts.green.medium, counts.green.total),
        dark: pct(counts.green.dark, counts.green.total),
      },
      red: {
        light: pct(counts.red.light, counts.red.total),
        medium: pct(counts.red.medium, counts.red.total),
        dark: pct(counts.red.dark, counts.red.total),
      },
    };
  }

  private computeScore(counts: HeatmapAnalyzerResult['counts'], opts: HeatmapAnalyzerOptions) {
    const gTotal = counts.green.total;
    const rTotal = counts.red.total;

    const direction = (gTotal - rTotal) / Math.max(1, gTotal + rTotal);

    const w = opts.weights;

    const avgStrength = (b: { light: number; medium: number; dark: number; total: number }) =>
      b.total ? (b.light * w.light + b.medium * w.medium + b.dark * w.dark) / (b.total * w.dark) : 0;

    let intensity = direction >= 0 ? avgStrength(counts.green) : avgStrength(counts.red);
    intensity = Math.pow(intensity, opts.shadeGamma); // 0..1

    const coverage = (gTotal + rTotal) / Math.max(1, counts.analyzedPixels);
    const coverFactor = opts.coverageFloor
      ? Math.min(1, Math.max(0, (coverage - opts.coverageFloor) / (1 - opts.coverageFloor)))
      : 1;

    const sentimentScore = Math.round(100 * direction * intensity * coverFactor);

    return { sentimentScore, debug: { direction, intensity, coverage } };
  }

  private rgbToHsv(r: number, g: number, b: number) {
    const rn = r / 255,
      gn = g / 255,
      bn = b / 255;
    const max = Math.max(rn, gn, bn),
      min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;

    if (d !== 0) {
      switch (max) {
        case rn:
          h = ((gn - bn) / d) % 6;
          break;
        case gn:
          h = (bn - rn) / d + 2;
          break;
        case bn:
          h = (rn - gn) / d + 4;
          break;
      }

      h *= 60;

      if (h < 0) h += 360;
    }

    const s = max === 0 ? 0 : d / max;
    const v = max;

    return { h, s, v };
  }

  private hslLightness(r: number, g: number, b: number) {
    const rn = r / 255,
      gn = g / 255,
      bn = b / 255;
    const mx = Math.max(rn, gn, bn);
    const mn = Math.min(rn, gn, bn);

    return (mx + mn) / 2;
  }

  private percentile(sorted: number[], p: number) {
    if (!sorted.length) return 0;

    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx),
      hi = Math.ceil(idx);

    if (lo === hi) return sorted[lo];

    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  }

  private isRedHue(h: number, redHueLowMax: number) {
    return (h >= 0 && h <= redHueLowMax) || (h >= 360 - redHueLowMax && h < 360);
  }
  private isGreenHue(h: number, min: number, max: number) {
    return h >= min && h <= max;
  }

  private shadeFromL(L: number, b1: number, b2: number): Shade {
    if (L >= b2) return 'light';
    else if (L >= b1) return 'medium';
    else return 'dark';
  }

  private familyOf(r: number, g: number, b: number, a: number, opts: HeatmapAnalyzerOptions): Family {
    if (a < 8) return FAMILY_NEUTRAL;
    else {
      const { h, s, v } = this.rgbToHsv(r, g, b);

      if (v < opts.minValue || s < opts.minSaturation) return FAMILY_NEUTRAL;
      else if (this.isGreenHue(h, opts.greenHueMin, opts.greenHueMax)) return FAMILY_GREEN;
      else if (this.isRedHue(h, opts.redHueLowMax)) return FAMILY_RED;
      else return FAMILY_NEUTRAL;
    }
  }
}
