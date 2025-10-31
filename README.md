# Coin180
*A cryptocurrency market sentiment quantifier and trend reversal predictor using visual data analysis.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.8+-yellow.svg)](https://www.python.org/)
[![License](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE.md)

---

## Overview

**Coin180** is an advanced market sentiment analysis and trading signal engine that detects **cryptocurrency trend reversals** using real-time visual data from [Coin360](https://coin360.com/). Unlike traditional sentiment analysis that relies on text or numerical indicators, Coin180 processes visual heatmap data to identify the precise moments when market momentum and direction begin to shift.

### Core Capabilities

- 🎯 **Visual Sentiment Extraction**: Converts color-coded market heatmaps into quantitative sentiment scores (-100 to +100)
- 📊 **Multi-Layer Signal Pipeline**: 5 specialized analyzers process data through adaptive filtering, trend detection, momentum analysis, and consensus voting
- 🚀 **GPU-Accelerated Processing**: Optional CuPy backend for high-performance image analysis
- 🔄 **Replay & Backtesting**: Re-analyze historical data with different configurations without recapturing
- 📝 **Comprehensive Logging**: Full JSONL event logs with PNG snapshots for audit trails
- ⚙️ **Configuration Presets**: 80+ tunable parameters per analyzer for fine-grained control

### Technology Stack

- **Backend**: Node.js + TypeScript (ES modules, strict mode)
- **Browser Automation**: Puppeteer (headless Chrome for heatmap capture)
- **Image Processing**: Python + pyvips + NumPy/CuPy (HSV color space analysis)
- **Testing**: Vitest with coverage reporting
- **Architecture**: Event-driven, stateful analyzers with rolling history windows

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Development](#development)
- [Tools & Utilities](#tools--utilities)
- [GPU Acceleration Setup](#gpu-acceleration-setup)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

### Prerequisites

- Node.js 20+ and npm
- Python 3.8+ (for heatmap analysis)
- Git

### Basic Setup

```powershell
# Clone the repository
git clone https://github.com/cconley717/Coin180.git
cd Coin180

# Install Node.js dependencies
npm install

# Set up Python environment
python -m venv .venv
.\.venv\Scripts\activate
pip install -r python/heatmap_service/requirements.txt

# Build the project
npm run build

# Run in development mode
npm run dev
```

The server will start on `http://0.0.0.0:3000` and begin capturing heatmaps from Coin360 every 5 seconds (configurable).

---

## Architecture

### Data Flow Pipeline

```text
┌─────────────────┐
│  Coin360.com    │
│  Canvas Capture │ ← Puppeteer evaluates canvas.toDataURL()
└────────┬────────┘
         │ PNG Buffer
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Python Heatmap Service                        │
│  • HSV Color Space Analysis  • Shade Classification (L/M/D)     │
│  • Neighbor Filtering        • GPU/CPU Backend Selection        │
└────────┬────────────────────────────────────────────────────────┘
         │ Sentiment Score (-100 to +100)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Analyzer Pipeline (Sequential)                │
│                                                                  │
│  1. DeltaFilterAnalyzer                                         │
│     • EMA smoothing with residual tracking                      │
│     • Jump capping & freeze threshold                           │
│                                                                  │
│  2. SlopeSignAnalyzer                                           │
│     • Linear regression over adaptive window                    │
│     • Direction detection: Up/Down/Flat                         │
│     • Hysteresis debouncing                                     │
│                                                                  │
│  3. MomentumCompositeAnalyzer                                   │
│     • Wilder RSI (14-period RMA)                                │
│     • Z-score normalization (30-window)                         │
│     • Weighted fusion: 60% RSI + 40% Z-score                    │
│                                                                  │
│  4. MovingAverageAnalyzer                                       │
│     • Short (5) vs Long (20) MA crossover                       │
│     • Spread-based confidence scoring                           │
│                                                                  │
│  5. TradeSignalAnalyzer (Fusion)                                │
│     • Consensus voting across 3 upstream signals                │
│     • Confidence-weighted averaging (20-tick window)            │
└────────┬────────────────────────────────────────────────────────┘
         │ { tradeSignal: 'buy'|'sell'|'neutral', confidence: 0-1 }
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Event Emission & Logging                      │
│  • 'tick' event with full analyzer results                      │
│  • JSONL log: records/trade-manager/trade-controllers/<id>_<timestamp>_<serviceTimestamp>/log.log │
│  • PNG heatmap: records/trade-manager/heatmaps/<serviceTimestamp>/<timestamp>.png (partitioned)   │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Patterns

#### 1. Stateful Analyzers
Each analyzer maintains internal state across ticks:
- **Rolling history windows**: Store recent values for moving averages, RSI, Z-score
- **Hysteresis buffers**: Accumulate evidence before confirming signal flips
- **Adaptive window sizing**: Shrink windows during high volatility (stdDev-based)

#### 2. Confidence Decay
Signals that persist without change gradually lose confidence via exponential decay:
```typescript
confidence *= Math.exp(-confidenceDecayRate * persistenceSteps)
```

#### 3. Python Subprocess Integration
- **Single long-lived process**: Spawned once, reused for all ticks
- **Line-delimited JSON**: Synchronous request/response over stdin/stdout
- **GPU auto-detection**: Falls back to NumPy if CuPy unavailable

---

## Installation

### System Requirements

- **Operating System**: Windows 10/11, macOS 10.15+, or Linux
- **Node.js**: Version 20 or higher
- **Python**: Version 3.8 or higher
- **Memory**: 4GB RAM minimum (8GB recommended for GPU mode)
- **Storage**: 500MB for dependencies + space for log files

### Step-by-Step Installation

#### 1. Install Node.js Dependencies

```powershell
npm install
```

This installs:
- Puppeteer (browser automation)
- Express (HTTP server)
- Sharp (image processing)
- TypeScript toolchain
- Vitest (testing framework)

#### 2. Set Up Python Environment

```powershell
# Create virtual environment
python -m venv .venv

# Activate (Windows)
.\.venv\Scripts\activate

# Activate (macOS/Linux)
source .venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install dependencies
pip install -r python/heatmap_service/requirements.txt
```

Python dependencies:
- `numpy`: Array operations
- `pyvips`: Fast image loading
- `scipy`: ndimage filtering (CPU fallback)

#### 3. Configure Environment (Optional)

Create a `.env` file in the project root:

```env
# Python executable path (optional, defaults to 'python')
PYTHON=python

# Heatmap processing backend: 'cpu' or 'gpu' (default: 'cpu')
HEATMAP_PROCESSING_AGENT=cpu

# Replay concurrency limit for both CPU and GPU (default: 4)
# Set to 0 to auto-detect CPU thread count
HEATMAP_PROCESSING_CONCURRENCY_LIMIT=4
```

#### 4. Build the Project

```powershell
npm run build
```

Compiles TypeScript to `dist/` directory with source maps and type declarations.

---

## Usage

### Running the System

#### Development Mode (Auto-reload)
```powershell
npm run dev
```
- Starts server with nodemon
- Automatically reloads on file changes
- Ideal for development and debugging

#### Production Mode
```powershell
npm run build
npm start
```
- Runs compiled JavaScript from `dist/`
- No auto-reload, optimized performance
- Use for production deployments

### Server Lifecycle

On startup, the server:
1. Loads configuration from `config/presets/test.json` (configurable in `src/server.ts`)
2. Creates a `TradeController` instance
3. Launches headless Chrome via Puppeteer
4. Navigates to `https://coin360.com/?period=1h`
5. Begins tick cycle at configured interval (default: 5000ms)

### Event Handling

Listen to events in `src/server.ts`:

```typescript
tradeController.on('started', (data) => {
  console.log('Controller started:', data.timestamp);
});

tradeController.on('tick', (data) => {
  console.log('Tick:', {
    timestamp: data.timestamp,
    sentiment: data.heatmapAnalyzer.result.sentimentScore,
    signal: data.tradeSignalFusion.result.tradeSignal,
    confidence: data.tradeSignalFusion.result.confidence
  });
});

tradeController.on('error', (err) => {
  console.error('Error:', err);
});

tradeController.on('stopped', (data) => {
  console.log('Controller stopped:', data.timestamp);
});
```

---

## Configuration

### Configuration Files

Preset configurations are stored in `config/presets/`:
- `default.json` - Standard parameters
- `test.json` - Development/testing parameters

### Configuration Structure

Each preset contains 7 major sections:

```json
{
  "identifier": "trade-controller-1",
  "isLoggingEnabled": true,
  "recordsDirectoryPath": "records",
  "url": "https://coin360.com/?period=1h",
  "captureInterval": 5000,
  "heatmapAnalyzerOptions": { /* 30+ parameters */ },
  "deltaFilterAnalyzerOptions": { /* 3 parameters */ },
  "slopeSignAnalyzerOptions": { /* 10 parameters */ },
  "momentumCompositeAnalyzerOptions": { /* 11 parameters */ },
  "movingAverageAnalyzerOptions": { /* 9 parameters */ },
  "tradeSignalAnalyzerOptions": { /* 3 parameters */ }
}
```

### Key Parameters

#### Heatmap Analyzer
- `pixelStep`: Sampling rate (1 = every pixel, 2 = every other pixel)
- `minSaturation`: HSV saturation threshold for color filtering
- `autoTuneMinSaturation`: Dynamically adjust saturation based on image
- `greenHueMin`/`greenHueMax`: Hue range for green (bullish) pixels
- `redHueLowMax`: Maximum hue for red (bearish) pixels
- `weights`: Shade intensity weights (`{light: 1, medium: 2, dark: 3}`)

#### Delta Filter
- `alpha`: EMA smoothing factor (0-1, higher = less smoothing)
- `maxJump`: Maximum allowed score change per tick
- `freezeThreshold`: Minimum delta to trigger an update

#### Slope Sign
- `slopeWindow`: Window size for linear regression
- `minSlopeMagnitude`: Minimum slope to trigger directional signal
- `hysteresisCount`: Ticks required to confirm direction flip
- `adaptiveMinWindow`/`adaptiveMaxWindow`: Range for volatility-based adaptation

#### Momentum Composite
- `rsiPeriod`: Wilder RSI period (typical: 14)
- `zWindow`: Z-score calculation window (typical: 30)
- `rsiWeight`/`zWeight`: Fusion weights (should sum to ~1.0)
- `buyThreshold`/`sellThreshold`: Signal confirmation thresholds

#### Moving Average
- `shortWindow`/`longWindow`: MA window sizes
- `hysteresisCount`: Crossover confirmation ticks
- `confidenceDecayRate`: Persistence decay coefficient

#### Trade Signal (Fusion)
- `windowSize`: Rolling average window for consensus (typical: 20)
- `buyThreshold`/`sellThreshold`: Final signal emission thresholds

---

## Development

### Building

```powershell
# Full build
npm run build

# Watch mode (not implemented - use npm run dev)
```

### Code Style

The project uses strict TypeScript with:
- `noUncheckedIndexedAccess`: Requires index access checks
- `exactOptionalPropertyTypes`: No `undefined` for optional properties
- `verbatimModuleSyntax`: Explicit `type` imports

ESM modules with `.js` extensions in imports (even for `.ts` files):
```typescript
import { TradeController } from './tradeController.js';
```

### Linting

```powershell
npm run lint
```

Uses ESLint with TypeScript plugin for type-aware linting.

---

## Tools & Utilities

### 1. Log Parser

Analyze JSONL log files to count signal distributions:

```powershell
# Parse default log.log
npm run parse-log -- trade-controller-1_<timestamp>_<serviceTimestamp>

# Parse specific log file
npm run parse-log -- trade-controller-1_<timestamp>_<serviceTimestamp> log-replay-1761937324979.log
```

**Output:**
```text
=== Trade Signal Analysis ===

SlopeSignAnalyzer:
  Buys:     4
  Sells:    4
  Neutrals: 1541
  Total:    1549

MomentumCompositeAnalyzer:
  Buys:     7
  Sells:    6
  Neutrals: 1536
  Total:    1549

MovingAverageAnalyzer:
  Buys:     0
  Sells:    0
  Neutrals: 1549
  Total:    1549

TradeSignalAnalyzer (Fusion):
  Buys:     119
  Sells:    77
  Neutrals: 1353
  Total:    1549
```

### 2. Replay Harness

Re-run analysis on captured heatmaps with different configurations:

```powershell
# Single-threaded (CPU) - set HEATMAP_PROCESSING_CONCURRENCY_LIMIT=1 in .env
npm run replay -- trade-controller-1_<timestamp>_<serviceTimestamp> test.json

# Multi-threaded (default: 4 workers) - set concurrency in .env
# HEATMAP_PROCESSING_CONCURRENCY_LIMIT=4
npm run replay -- trade-controller-1_<timestamp>_<serviceTimestamp> test.json

# Auto-detect CPU thread count - set to 0 in .env
# HEATMAP_PROCESSING_CONCURRENCY_LIMIT=0
npm run replay -- trade-controller-1_<timestamp>_<serviceTimestamp> test.json

# GPU-accelerated - set backend in .env
# HEATMAP_PROCESSING_AGENT=gpu
# HEATMAP_PROCESSING_CONCURRENCY_LIMIT=4
npm run replay -- trade-controller-1_<timestamp>_<serviceTimestamp> test.json
```

**Use Cases:**
- **A/B Testing**: Compare parameter changes on same dataset
- **Debugging**: Inspect analyzer behavior without live capture
- **Validation**: Ensure config changes don't break signal generation

**Output:** `replay_<timestamp>.log` (JSONL format)

---

## GPU Acceleration Setup

GPU acceleration can provide **5-10x faster** heatmap analysis during replay. Required for high-frequency parameter tuning.

### Prerequisites

- NVIDIA GPU with CUDA support
- CUDA Toolkit (13.x or 12.x)
- libvips runtime library

### Installation Steps

#### 1. Install CUDA Toolkit

Download from [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) and install.

Verify installation:
```powershell
nvcc --version
```

If not found, add to `PATH`:
```text
C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.0\bin
```

#### 2. Install libvips

**Windows:**
1. Download from [libvips releases](https://github.com/libvips/libvips/releases/latest)
2. Extract to `C:\libvips`
3. Add `C:\libvips\bin` to `PATH`

**macOS:**
```bash
brew install vips
```

**Linux:**
```bash
sudo apt-get install libvips-dev  # Debian/Ubuntu
```

#### 3. Install Python Dependencies

```powershell
# Activate venv if not already active
.\.venv\Scripts\activate

# Install base requirements (includes numpy, pyvips)
pip install -r python/heatmap_service/requirements.txt

# Install CuPy for your CUDA version
pip install cupy-cuda13x  # For CUDA 13.x
# OR
pip install cupy-cuda12x  # For CUDA 12.x
```

#### 4. Verify GPU Backend

```powershell
python -c "import sys, pathlib; sys.path.insert(0, str(pathlib.Path('python/heatmap_service').resolve())); import gpu_heatmap_analyzer as gha; print('backend:', gha.GPU_BACKEND)"
```

**Expected output:** `backend: cupy`

If it prints `backend: numpy`, check:
1. CuPy installed for correct CUDA version
2. CUDA Toolkit in PATH
3. GPU drivers up to date

#### 5. Configure Concurrency

Set worker pool size in `.env`:
```env
# Replay concurrency limit for both CPU and GPU (default: 4)
# Set to 0 to auto-detect based on CPU thread count
HEATMAP_PROCESSING_CONCURRENCY_LIMIT=4
```

**Concurrency Guidelines:**

*For GPU Mode:*
- GTX 1060/1070: 2-4 workers
- RTX 2060/3060: 4-8 workers
- RTX 3080/3090: 8-16 workers

*For CPU Mode:*
- Set to `0` for automatic detection (uses all available CPU threads)
- Set to `1` for single-threaded mode (useful for debugging)
- Set to `4` (default) for balanced performance on most systems

#### 6. Test GPU Replay

First, configure GPU mode in `.env`:
```env
HEATMAP_PROCESSING_AGENT=gpu
HEATMAP_PROCESSING_CONCURRENCY_LIMIT=4
```

Then run replay:
```powershell
npm run replay -- trade-controller-1_<timestamp>_<serviceTimestamp> test.json
```

Check logs for `"backend": "cupy"` in each tick's debug output.

---

## Testing

### Run Tests

```powershell
# Watch mode (auto-rerun on changes)
npm test

# Single run
npm run test:run

# With coverage report
npm run test:ci
```

### Test Structure

Tests are located in `src/__tests__/`:
- `analyzeHeatmap.spec.ts` - Heatmap analyzer validation

Reference images in `src/__tests__/test_data/`:
- `green_1.png` → Expected score: 33 (light green)
- `green_2.png` → Expected score: 67 (medium green)
- `green_3.png` → Expected score: 100 (dark green)
- `red_1.png` → Expected score: -33 (light red)
- `red_2.png` → Expected score: -67 (medium red)
- `red_3.png` → Expected score: -100 (dark red)

### Coverage Reports

Generated in `coverage/` directory after `npm run test:ci`:
- HTML report: `coverage/index.html`
- LCOV format for CI integration

---

## Project Structure

```text
Coin180/
├── .github/
│   └── copilot-instructions.md    # AI coding assistant guide
├── config/
│   └── presets/
│       ├── default.json           # Standard configuration
│       └── test.json              # Development configuration
├── coverage/                      # Test coverage reports
├── dist/                          # Compiled JavaScript (gitignored)
├── python/
│   └── heatmap_service/
│       ├── main.py                # STDIN/STDOUT JSON RPC loop
│       ├── gpu_heatmap_analyzer.py # HSV analysis (500+ lines)
│       └── requirements.txt       # Python dependencies
├── records/                       # Generated logs + PNGs (gitignored)
│   └── trade-manager/
│       ├── heatmaps/              # Centralized heatmap storage (partitioned by service)
│       │   └── <serviceTimestamp>/
│       │       └── <timestamp>.png    # Heatmap snapshots
│       └── trade-controllers/
│           └── trade-controller-1_<timestamp>_<serviceTimestamp>/
│               └── log.log        # JSONL event log
├── src/
│   ├── __tests__/
│   │   ├── analyzeHeatmap.spec.ts
│   │   └── test_data/             # Reference images
│   ├── services/
│   │   ├── pythonHeatmap/
│   │   │   └── agent.ts           # Node ↔ Python subprocess manager
│   │   └── tradeManager/
│   │       ├── analyzers/
│   │       │   ├── deltaFilterAnalyzer.ts
│   │       │   ├── slopeSignAnalyzer.ts
│   │       │   ├── momentumCompositeAnalyzer.ts
│   │       │   ├── movingAverageAnalyzer.ts
│   │       │   ├── tradeSignalAnalyzer.ts
│   │       │   └── wilderMomentumAnalyzer.ts
│   │       ├── core/
│   │       │   ├── types.ts       # Interfaces, enums, type aliases
│   │       │   ├── options.ts     # Configuration interfaces
│   │       │   └── helpers.ts     # Color space, image utilities
│   │       ├── tradeController.ts # Main orchestration loop
│   │       └── tradeManagerService.ts
│   ├── tools/
│   │   ├── heatmapReplay/
│   │   │   └── replay.ts          # Offline analysis harness
│   │   └── logParser/
│   │       └── parser.ts          # JSONL log analyzer
│   ├── app.ts                     # Express app
│   └── server.ts                  # Entry point
├── .env                           # Environment variables (gitignored)
├── eslint.config.mts              # ESLint configuration
├── package.json                   # Node.js dependencies + scripts
├── tsconfig.json                  # TypeScript compiler options
├── vitest.config.ts               # Vitest test runner config
├── LICENSE.md                     # ISC License
└── README.md                      # This file
```

---

## Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**:
   - Follow existing code style (ESLint will check)
   - Add tests for new features
   - Update documentation as needed
4. **Run tests**: `npm run test:ci`
5. **Build successfully**: `npm run build`
6. **Commit changes**: `git commit -m 'Add amazing feature'`
7. **Push to branch**: `git push origin feature/amazing-feature`
8. **Open a Pull Request**

### Development Best Practices

- Use strict TypeScript - no `any` types
- Include `.js` extensions in import paths
- Write tests for analyzer logic
- Document complex algorithms with comments
- Use debug snapshots for troubleshooting

---

## License

This project is licensed under the ISC License - see the [LICENSE.md](LICENSE.md) file for details.

---

## Acknowledgments

- [Coin360](https://coin360.com/) for providing the visual market data
- [Puppeteer](https://pptr.dev/) for browser automation
- [pyvips](https://libvips.github.io/pyvips/) for fast image processing
- [CuPy](https://cupy.dev/) for GPU-accelerated array operations

---

## Support

For questions, issues, or feature requests:
- Open an issue on [GitHub Issues](https://github.com/cconley717/Coin180/issues)
- Check existing issues before creating new ones
- Provide logs and configuration when reporting bugs

---

**Built with ❤️ for cryptocurrency market analysis**
