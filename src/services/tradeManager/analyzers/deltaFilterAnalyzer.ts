import type { DeltaFilterAnalyzerOptions } from "../core/options.js";
import type { DeltaFilterDebug } from "../core/types.js";

export class DeltaFilterAnalyzer {
  private lastFiltered = 0;
  private initialized = false;

  private readonly maxJump: number;
  private readonly alpha: number;
  private readonly freezeThreshold: number;

  private residual = 0;
  private lastDebug: DeltaFilterDebug | null = null;

  constructor(options: DeltaFilterAnalyzerOptions) {
    if (!options)
      throw new Error('DeltaFilter requires explicit options.');

    const alpha = options.alpha;
    const maxJump = options.maxJump;
    const freeze = options.freezeThreshold;

    this.alpha = Math.min(1, Math.max(1e-6, alpha));
    this.maxJump = Math.max(0, maxJump);
    this.freezeThreshold = Math.max(0, freeze);
  }

  public getDebugSnapshot(): DeltaFilterDebug | null {
    if (!this.lastDebug)
      return null;

    return { ...this.lastDebug };
  }

  public update(rawScore: number): number {
    if (!Number.isFinite(rawScore))
      return this.lastFiltered;

    if (!this.initialized) {
      this.lastFiltered = rawScore;
      this.initialized = true;
      this.residual = 0;

      this.lastDebug = {
        rawScore,
        previousFiltered: rawScore,
        residualBefore: 0,
        residualAfter: 0,
        desiredStep: 0,
        appliedStep: 0,
        froze: false,
        maxJumpHit: false
      };

      return rawScore;
    }

    const previousFiltered = this.lastFiltered;
    const delta = rawScore - previousFiltered;
    const residualBefore = this.residual + delta;
    this.residual = residualBefore;

    const desiredStep = this.alpha * this.residual;

    if (Math.abs(this.residual) < this.freezeThreshold) {
      this.lastDebug = {
        rawScore,
        previousFiltered,
        residualBefore,
        residualAfter: this.residual,
        desiredStep,
        appliedStep: 0,
        froze: true,
        maxJumpHit: false
      };

      return this.lastFiltered;
    }

    const appliedStep =
      Math.sign(desiredStep) * Math.min(Math.abs(desiredStep), this.maxJump);

    this.lastFiltered = previousFiltered + appliedStep;

    const appliedInputDelta = appliedStep / this.alpha;
    this.residual -= appliedInputDelta;

    this.lastDebug = {
      rawScore,
      previousFiltered,
      residualBefore,
      residualAfter: this.residual,
      desiredStep,
      appliedStep,
      froze: false,
      maxJumpHit: Math.abs(appliedStep) < Math.abs(desiredStep) - 1e-9
    };

    return this.lastFiltered;
  }

  public reset(): void {
    this.initialized = false;
    this.lastFiltered = 0;
    this.residual = 0;
    this.lastDebug = null;
  }
}
