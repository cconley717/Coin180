import fs from 'node:fs';
import readline from 'node:readline';
import { TradeSignal } from './tradeManager/core/types.js';

export interface ChartDataPoint {
  x: number;
  y: number;
  color: string;
}

export interface HistogramData {
  sentimentScore: ChartDataPoint[];
  fusionConfidence: ChartDataPoint[];
  slopeConfidence: ChartDataPoint[];
  momentumConfidence: ChartDataPoint[];
}

interface TickData {
  tick: {
    timestamp: number;
    heatmapAnalyzer: {
      result: {
        sentimentScore: number;
      };
    };
    slopeSignAnalyzer: {
      result: {
        tradeSignal: TradeSignal;
        confidence: number;
      };
    };
    momentumCompositeAnalyzer: {
      result: {
        tradeSignal: TradeSignal;
        confidence: number;
      };
    };
    tradeSignalFusion: {
      result: {
        tradeSignal: TradeSignal;
        confidence: number;
      };
    };
  };
}

function signalToColor(signal: TradeSignal): string {
  switch (signal) {
    case TradeSignal.Buy:
      return '#10b981'; // Green
    case TradeSignal.Sell:
      return '#ef4444'; // Red
    default:
      return '#6b7280'; // Gray (neutral)
  }
}

export async function loadChartDataFromLog(logFilePath: string): Promise<HistogramData> {
  const data: HistogramData = {
    sentimentScore: [],
    fusionConfidence: [],
    slopeConfidence: [],
    momentumConfidence: [],
  };

  const fileStream = fs.createReadStream(logFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let tickIndex = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed: TickData = JSON.parse(line);
      if (!parsed.tick) continue;

      const { tick } = parsed;

      // Use tick index for x-axis (more readable than timestamps)
      const x = tickIndex++;

      // Histogram 1: Sentiment Score colored by Fusion signal
      data.sentimentScore.push({
        x,
        y: tick.heatmapAnalyzer.result.sentimentScore,
        color: signalToColor(tick.tradeSignalFusion.result.tradeSignal),
      });

      // Histogram 2: Fusion Confidence colored by Fusion signal
      data.fusionConfidence.push({
        x,
        y: tick.tradeSignalFusion.result.confidence,
        color: signalToColor(tick.tradeSignalFusion.result.tradeSignal),
      });

      // Histogram 3: Slope Confidence colored by Slope signal
      data.slopeConfidence.push({
        x,
        y: tick.slopeSignAnalyzer.result.confidence,
        color: signalToColor(tick.slopeSignAnalyzer.result.tradeSignal),
      });

      // Histogram 4: Momentum Confidence colored by Momentum signal
      data.momentumConfidence.push({
        x,
        y: tick.momentumCompositeAnalyzer.result.confidence,
        color: signalToColor(tick.momentumCompositeAnalyzer.result.tradeSignal),
      });
    } catch {
      // Skip invalid lines (e.g., "started" line)
      continue;
    }
  }

  return data;
}
