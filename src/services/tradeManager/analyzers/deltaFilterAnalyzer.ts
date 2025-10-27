import type { DeltaFilterAnalyzerOptions } from "../core/options.js";

export class DeltaFilterAnalyzer {
  private lastFiltered = 0;
  private initialized = false;

  private readonly maxJump: number;         // output step cap per update
  private readonly alpha: number;           // smoothing factor
  private readonly freezeThreshold: number; // deadband threshold

  // Accumulates sub-threshold deltas so they eventually apply
  private residual = 0;

  constructor(options: DeltaFilterAnalyzerOptions) {
    if (!options)
      throw new Error('DeltaFilter requires explicit options.');

    const alpha = options.alpha;
    const maxJump = options.maxJump;
    const freeze = options.freezeThreshold;

    // ✅ Parameter validation / clamping
    this.alpha = Math.min(1, Math.max(1e-6, alpha)); // avoid 0 to prevent stalls/div-by-zero
    this.maxJump = Math.max(0, maxJump);
    this.freezeThreshold = Math.max(0, freeze);
  }

  public update(rawScore: number): number {
    // ✅ NaN/Infinity guard
    if (!Number.isFinite(rawScore))
      return this.lastFiltered;

    if (!this.initialized) {
      // First sample: seed state (there is no prior baseline to smooth from)
      this.lastFiltered = rawScore;
      this.initialized = true;
      this.residual = 0;

      return rawScore;
    }

    // Accumulate raw delta into residual (fixes deadband "stickiness")
    const delta = rawScore - this.lastFiltered;
    this.residual += delta;

    // If the effective movement is still tiny, hold position
    if (Math.abs(this.residual) < this.freezeThreshold) {
      return this.lastFiltered;
    }

    // Low-pass smooth toward the target using the residual
    // (how much we'd like to move this tick)
    const desiredStep = this.alpha * this.residual;

    // ✅ Cap the OUTPUT step (now maxJump means what it says)
    const step =
      Math.sign(desiredStep) *
      Math.min(Math.abs(desiredStep), this.maxJump);

    const filtered = this.lastFiltered + step;

    // Update state
    this.lastFiltered = filtered;

    // Remove the portion of residual we actually applied (convert step back to input-delta units)
    const appliedInputDelta = step / this.alpha;
    this.residual -= appliedInputDelta;

    return filtered;
  }

  public reset(): void {
    this.initialized = false;
    this.lastFiltered = 0;
    this.residual = 0;
  }
}
