# Coin180 - Crypto Market Sentiment Analyzer

A sophisticated real-time trading analysis platform that processes visual market data from Coin360.com to detect market trend reversals and generate trading signals through layered signal fusion.

<img width="1493" height="1059" alt="image" src="https://github.com/user-attachments/assets/8878d6ae-0aab-45bd-b90c-80d69ae27690" />

## 🚀 Core Features

### Real-Time Market Capture

- **Automated Screenshot Capture**: Headless browser captures Coin360.com heatmaps every 5 seconds
- **GPU-Accelerated Processing**: Optional CuPy backend for high-performance Python-based image analysis
- **Distributed Architecture**: Single capture service feeds multiple analysis controllers

### Advanced Visual Analysis Pipeline

- **Sentiment Extraction**: Converts color-coded heatmaps into quantitative sentiment scores (-100 to +100)
- **Multi-Layer Signal Processing**: 5 specialized analyzers working in concert:
  - **Heatmap Analyzer**: HSV color space analysis with adaptive thresholding
  - **Delta Filter**: Smooths sentiment noise while preserving significant changes
  - **Slope Sign Analyzer**: Detects trend direction with adaptive window sizing
  - **Momentum Composite**: RSI + Z-score momentum analysis with hysteresis
  - **Trade Signal Fusion**: Consensus voting with configurable weights

### Intelligent Signal Generation

- **Consensus-Based Trading Signals**: Buy/Sell/Neutral with confidence scoring
- **Adaptive Algorithms**: Dynamic parameter adjustment based on market volatility
- **Hysteresis Filtering**: Prevents signal whipsawing during market noise
- **Multi-Timeframe Analysis**: Rolling window processing with configurable depths

### Real-Time Web Dashboard

- **Live Visualization**: Socket.IO-powered real-time charts and indicators
- **7-State Sentiment Display**: Visual indicator mapping sentiment to market states
- **Interactive Heatmaps**: Click-to-enlarge modal viewing of market conditions
- **Historical Replay**: Review past sessions with full data fidelity

### Comprehensive Logging & Replay

- **JSONL Event Logging**: Complete audit trail with PNG snapshots
- **Backtesting Framework**: Re-analyze historical data with different configurations
- **Data Export**: Chart-ready data structures for external analysis
- **Session Management**: Isolated controller instances with unique identifiers

## 🏗️ Technical Architecture

### Backend (Node.js/TypeScript)

- **Express API Server**: RESTful endpoints for controller management and data serving
- **Socket.IO Integration**: Real-time bidirectional communication with web clients
- **Puppeteer Automation**: Headless Chrome for reliable market data capture
- **Event-Driven Design**: Asynchronous processing with comprehensive error handling

### Computer Vision Pipeline

- **Dual Implementation**: Node.js (Sharp) and Python (PyVIPS) heatmap analyzers
- **Advanced Image Processing**: HSL color space analysis with neighbor filtering
- **Adaptive Thresholding**: Auto-tuning saturation thresholds based on image statistics
- **Performance Optimization**: Pixel stepping and region-of-interest processing

### Analysis Engine

- **Modular Analyzer Design**: Independent components with standardized interfaces
- **Rolling History Windows**: Configurable data retention for trend analysis
- **Confidence Scoring**: Probabilistic signal strength assessment
- **Debug Capabilities**: Detailed analysis snapshots for algorithm tuning

## 📊 Key Components

### Heatmap Analyzer

- Processes PNG images to extract market sentiment
- HSV color space conversion with saturation/value gating
- Adaptive lightness thresholding for green/red classification
- Neighbor agreement filtering for noise reduction

### Signal Analyzers

- **Slope Sign**: Trend direction detection with configurable windows
- **Momentum Composite**: RSI and Z-score combination with adaptive scaling
- **Delta Filter**: Exponential smoothing with freeze thresholds
- **Trade Fusion**: Weighted consensus voting with sentiment integration

### Web Interface

- **Live Dashboard**: Real-time sentiment charts and heatmap visualization
- **Replay System**: Historical data review with interactive controls
- **API Endpoints**: RESTful access to controller management and data export

## ⚙️ Configuration & Tuning

### Extensive Parameter Control

80+ configurable parameters across all analyzers:

- **Heatmap Analysis**: Pixel sampling, color thresholds, blur parameters
- **Signal Processing**: Window sizes, thresholds, decay rates, hysteresis
- **Adaptive Behavior**: Sensitivity tuning, volatility scaling, confidence thresholds

### Preset Configurations

Multiple configuration profiles for different market conditions:

- **Default**: Balanced parameters for general market conditions
- **Conservative**: Reduced sensitivity for stable trending markets
- **Test**: Minimal configuration for development and testing

## 🔧 Installation & Usage

### Prerequisites

- Node.js 18+, Python 3.8+ (optional), Puppeteer dependencies
- Optional: CUDA-compatible GPU for accelerated processing

### Quick Start

```bash
npm install
npm run build
npm start
```

Access the dashboard at `http://localhost:3000`

### Development

```bash
npm run dev          # Development server with hot reload
npm test            # Run test suite
npm run replay      # Historical data replay
npm run parse-log   # Log file analysis
```

## 🎯 Use Cases

- **Trend Reversal Detection**: Identify precise moments when market momentum shifts
- **Sentiment Analysis**: Quantitative measurement of market psychology through visual data
- **Signal Generation**: Automated buy/sell signal generation with confidence scoring
- **Backtesting**: Historical analysis with parameter optimization
- **Real-time Monitoring**: Live dashboard for active trading decisions

## 🔬 Technical Specifications

- **Analysis Frequency**: 5-second intervals (configurable)
- **Sentiment Range**: -100 (extreme bearish) to +100 (extreme bullish)
- **Signal Confidence**: 0-100% probabilistic assessment
- **Data Retention**: Rolling windows with configurable depths
- **Image Resolution**: 1920x1080 heatmap processing
- **Processing Latency**: <100ms per analysis cycle

## 📝 License

GNU GENERAL PUBLIC LICENSE - See LICENSE.md for details

---

_Coin180 processes visual market data to provide quantitative insights into cryptocurrency market sentiment and trend dynamics._</content>
<parameter name="filePath">d:\projects\Coin180\README.md
