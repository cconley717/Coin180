# Coin180 Development Guide

## Project Overview
Coin180 is a cryptocurrency market sentiment analysis system that captures real-time heatmap visualizations from coin360.com using Puppeteer, extracts sentiment via GPU-accelerated Python image processing, and feeds that data through a multi-layer analyzer pipeline to generate buy/sell trade signals.

**Purpose**: Detect trend reversals by observing the moment when market momentum and direction shift, using visual market data as the primary input.

## Architecture: Data Flow

1. **Capture** (`TradeController.tick()`) → Puppeteer evaluates canvas via `page.evaluate()`, converts to PNG buffer
2. **Heatmap Analysis** (`PythonHeatmapAgent` ↔ `python/heatmap_service/`) → HSV color space analysis extracts red/green pixel distributions with shade weighting (light/medium/dark), returns `sentimentScore` (-100 to +100)
3. **Signal Pipeline** (5 analyzers sequenced in `TradeController.getSentimentScoreAnalysisReports()`):
   - `DeltaFilterAnalyzer` → EMA smoothing with residual accumulation, caps jumps via `maxJump`, freezes below `freezeThreshold`
   - `SlopeSignAnalyzer` → Linear regression over adaptive window, hysteresis-debounced direction changes (up/down/flat)
   - `MomentumCompositeAnalyzer` → Wilder RSI + Z-score fusion weighted by `rsiWeight`/`zWeight`, hysteresis for signal confirmation
   - `MovingAverageAnalyzer` → Short/long MA crossover detection with spread-based confidence
   - `TradeSignalAnalyzer` → Consensus voting across 3 upstream signals, confidence-weighted averaging over `windowSize` ticks
4. **Output** → `tick` event emitted with `{ timestamp, heatmapAnalyzer, deltaFilterAnalyzer, slopeSignAnalyzer, momentumCompositeAnalyzer, movingAverageAnalyzer, tradeSignalFusion }`

Each analyzer is **stateful** with rolling history windows. Adaptive analyzers (`SlopeSign`, `MomentumComposite`, `MovingAverage`) shrink windows during high volatility (stdDev-based).

## Key Conventions

### Configuration Management
- Preset files: `config/presets/{default,test}.json` (80+ parameters per preset)
- Load via `loadPreset(filename)` in `server.ts` → returns `TradeControllerOptions`
- All options typed in `src/services/tradeManager/core/options.ts`:
  - `HeatmapAnalyzerOptions`: HSV thresholds, neighbor filtering, shade weights
  - `DeltaFilterAnalyzerOptions`: `alpha`, `maxJump`, `freezeThreshold`
  - `SlopeSignAnalyzerOptions`: `slopeWindow`, `minSlopeMagnitude`, `hysteresisCount`, adaptive params
  - `MomentumCompositeAnalyzerOptions`: `rsiPeriod`, `zWindow`, buy/sell thresholds, hysteresis
  - `MovingAverageAnalyzerOptions`: `shortWindow`, `longWindow`, hysteresis, adaptive params
  - `TradeSignalAnalyzerOptions`: `windowSize`, `buyThreshold`, `sellThreshold`

### Python Integration Pattern
- `PythonHeatmapAgent.create()` spawns long-lived subprocess (`python/heatmap_service/main.py`)
- Communication: line-delimited JSON over stdin/stdout
  - **Send**: `{ pngBase64: string, options: HeatmapAnalyzerOptions }`
  - **Receive**: `{ heatmap: { result: HeatmapAnalyzerResult, debug: HeatmapAnalyzerDebug | null } }` OR `{ error: string }`
- Agent lifecycle: singleton per controller, reused for all ticks, disposed on `stop()`
- GPU backend selection: `gpu_heatmap_analyzer.py` checks `HEATMAP_PROCESSING_AGENT` env var (defaults to `cpu`)
  - `"gpu"` → uses CuPy + cupyx.scipy.ndimage (falls back to NumPy if unavailable)
  - `"cpu"` → NumPy + scipy.ndimage
- Image processing: pyvips loads PNG → RGB/HSV/LAB color spaces → gaussian blur → CuPy/NumPy arrays for vectorized operations

### Logging & Replay
- When `isLoggingEnabled: true`, writes to:
  - Controller logs: `records/trade-manager/trade-controllers/<identifier>_<timestamp>/log.log` (JSONL with one `{"tick": {...}}` per line)
  - Centralized heatmaps: `records/trade-manager/heatmaps/<timestamp>.png` (shared across all controllers, stored once by TradeManagerService)
- Log structure: `{ started: {...} }` (first line), then `{ tick: { timestamp, heatmapAnalyzer, ...analyzers, tradeSignalFusion } }`
- **Replay harness** (`src/tools/heatmapReplay/replay.ts`):
  - Re-runs analysis on captured PNGs with different preset configs
  - Modes: sync (single-threaded), `async` (multi-worker CPU), `async gpu` (multi-worker GPU)
  - Worker pool size: `REPLAY_GPU_CONCURRENCY` env var (default: 4)
  - Output: `replay_<timestamp>.log` in JSONL format
  - Usage: `npm run replay -- <record-folder> <preset-name> [async] [gpu]`

### Analyzer Design Pattern
**Common interface**:
```typescript
class XyzAnalyzer {
  private readonly history: number[] = [];
  private lastDebug: XyzDebug | null = null;
  
  constructor(options: XyzAnalyzerOptions) { /* validate, store options */ }
  
  update(input: InputType): OutputType {
    // 1. Append to history, trim to max window size
    // 2. Compute metric (slope/RSI/MA/etc.)
    // 3. Apply hysteresis if applicable
    // 4. Decay confidence if signal persists
    // 5. Store debug snapshot
    // 6. Return { tradeSignal, confidence }
  }
  
  getDebugSnapshot(): XyzDebug | null { return this.lastDebug ? {...this.lastDebug} : null; }
}
```

**Key patterns**:
- **Hysteresis debouncing**: Accumulate `hysteresisBuffer` for `hysteresisCount` ticks before confirming signal flip (prevents oscillation)
- **Adaptive windows**: Compute stdDev over recent history → higher volatility = shorter window (responsive to regime changes)
  - Formula: `adaptiveSize = adaptiveMaxWindow - normalized * (adaptiveMaxWindow - adaptiveMinWindow)`
  - Normalization: `min(1, (stdDev / adaptiveVolScale) * adaptiveSensitivity)`
- **Confidence decay**: When signal persists without flip, apply `exp(-confidenceDecayRate * persistenceSteps)` to reduce confidence over time
- **WilderMomentumAnalyzer** (used by `MomentumCompositeAnalyzer`): Implements Wilder's RSI with RMA (Running Moving Average) instead of SMA

### Type System & Enums
- `TradeSignal` enum: `Buy | Sell | Neutral` (lowercase string literals)
- `SlopeDirection` enum: `Up | Down | Flat`
- All analyzer results: `{ tradeSignal: TradeSignal, confidence: number }` where confidence ∈ [0, 1]
- Heatmap shade tallies: `{ light: number, medium: number, dark: number, total: number }`
- Debug snapshots: every analyzer has `XyzDebug` interface with `reason` string + internal state fields

## Development Workflows

### Running the System
```powershell
npm run dev              # Start server with nodemon (auto-reload on file changes)
npm start                # Production mode (requires prior `npm run build`)
```
Server listens on `http://0.0.0.0:3000`. On startup:
1. Loads preset from `config/presets/test.json` (or change filename in `server.ts`)
2. Creates `TradeController` instance via `TradeManagerService`
3. Calls `tradeController.start()` → launches Puppeteer, navigates to coin360.com, begins tick cycle
4. Emits `started`, `tick`, `stopped`, `error` events

### Testing
```powershell
npm test                 # Vitest watch mode (auto-reruns on changes)
npm run test:run         # Single run (CI-friendly)
npm run test:ci          # With coverage report → coverage/ directory
```
Test files: `src/__tests__/analyzeHeatmap.spec.ts` validates heatmap analyzer against reference PNG images in `src/__tests__/test_data/` (green_1.png → score 33, green_3.png → score 100, etc.)

### Log Analysis
```powershell
npm run parse-log -- records/trade-manager/trade-controllers/trade-controller-1_<timestamp>/log.log
```
Outputs summary: buy/sell/neutral counts per analyzer (see `src/tools/logParser/parser.ts`)

### Replay Analysis
```powershell
npm run replay -- trade-controller-1_1761756068332 test.json        # Sync, CPU
npm run replay -- trade-controller-1_1761756068332 test.json async  # Async, CPU, multi-worker
npm run replay -- trade-controller-1_1761756068332 test.json async gpu  # Async, GPU, multi-worker
```
Use cases:
- A/B test analyzer parameters (change preset, re-run replay on same heatmaps)
- Debug signal generation without re-capturing live data
- Validate config changes before deploying to live system

### GPU Setup (Optional, for Replay Performance)
1. Install CUDA Toolkit matching CuPy wheel (e.g., CUDA 13.x): [NVIDIA CUDA downloads](https://developer.nvidia.com/cuda-toolkit)
2. Install libvips: [libvips releases](https://github.com/libvips/libvips/releases) → extract, add `bin/` to PATH
3. Create Python venv: `python -m venv .venv && .\.venv\Scripts\activate`
4. Install deps: `pip install -r python/heatmap_service/requirements.txt`
5. Install CuPy: `pip install cupy-cuda13x` (or `cupy-cuda12x` for CUDA 12.x)
6. Verify GPU backend:
   ```powershell
   python -c "import sys, pathlib; sys.path.insert(0, str(pathlib.Path('python/heatmap_service').resolve())); import gpu_heatmap_analyzer as gha; print('backend:', gha.GPU_BACKEND)"
   ```
   Should print `backend: cupy` (falls back to `numpy` if CuPy unavailable)
7. Set concurrency: `REPLAY_GPU_CONCURRENCY=4` in `.env` (adjust for your GPU)

## Critical Files & Directories

- **`src/services/tradeManager/tradeController.ts`**: Main orchestration loop
  - `tick()`: Puppeteer capture → heatmap analysis → analyzer pipeline → emit event
  - `analyzeRawHeatmap()`: Entry point for offline analysis (used by replay harness)
- **`src/services/tradeManager/analyzers/`**: 6 analyzer implementations
  - `deltaFilterAnalyzer.ts`: EMA smoothing with residual tracking
  - `slopeSignAnalyzer.ts`: Linear regression trend detection
  - `momentumCompositeAnalyzer.ts`: RSI + Z-score fusion
  - `movingAverageAnalyzer.ts`: MA crossover strategy
  - `tradeSignalAnalyzer.ts`: Consensus voting across upstream signals
  - `wilderMomentumAnalyzer.ts`: Wilder RSI implementation (used by MomentumComposite)
- **`src/services/tradeManager/core/`**:
  - `types.ts`: All interfaces, enums, type aliases
  - `options.ts`: Configuration interfaces for all analyzers
  - `helpers.ts`: Color space conversions (RGB→HSV), image loading, neighbor filtering
- **`src/services/pythonHeatmap/agent.ts`**: Node ↔ Python subprocess manager
- **`python/heatmap_service/`**:
  - `main.py`: STDIN/STDOUT JSON RPC loop
  - `gpu_heatmap_analyzer.py`: HSV analysis, neighbor filtering, shade classification (500+ lines of vectorized NumPy/CuPy)
- **`src/tools/heatmapReplay/replay.ts`**: Offline analysis harness with worker pool
- **`src/tools/logParser/parser.ts`**: JSONL log summarizer
- **`config/presets/`**: Parameter tuning profiles (`default.json`, `test.json`)
- **`records/`**: Generated data (gitignored)
  - `records/trade-manager/heatmaps/`: Centralized PNG heatmap storage (shared across all controllers)
  - `records/trade-manager/trade-controllers/<identifier>_<timestamp>/`: Per-controller JSONL logs

## Code Style & TypeScript Config

- **Strict mode**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- **Module system**: ES modules (`type: "module"` in package.json)
  - Import paths must include `.js` extension (even for `.ts` files): `import { Foo } from './foo.js'`
- **Event-driven architecture**: `TradeController extends EventEmitter`
  - Events: `started`, `stopped`, `tick`, `error`
  - Listeners: `tradeController.on('tick', (data) => { ... })`
- **No implicit any**: All function signatures, class properties, and analyzer inputs/outputs are strongly typed
- **Array access safety**: Use `.at()` for negative indices, `arr[i]!` assertion only after bounds check
- **Optional chaining**: Preferred for nested objects: `data.tick?.slopeSignAnalyzer?.result?.tradeSignal`
