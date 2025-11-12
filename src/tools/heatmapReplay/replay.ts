import fs from 'node:fs/promises';
import { createWriteStream, WriteStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isMainThread } from 'node:worker_threads';
import os from 'node:os';
import dotenv from 'dotenv';
import type { HeatmapAnalyzerOptions, TradeControllerOptions } from '../../services/tradeManager/core/options.js';
import { TradeController } from '../../services/tradeManager/tradeController.js';
import { HeatmapAnalyzer } from '../../services/tradeManager/analyzers/heatmapAnalyzer.js';
import { PythonHeatmapAgent } from '../../services/pythonHeatmap/agent.js';
import type { HeatmapAnalyzerResult } from '../../services/tradeManager/core/types.js';

let logStream: WriteStream;

interface HeatmapFrameMeta {
  timestamp: number;
  filePath: string;
}

async function loadHeatmapFrames(heatmapDir: string): Promise<HeatmapFrameMeta[]> {
  const entries = await fs.readdir(heatmapDir);

  const frames: HeatmapFrameMeta[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.png')) continue;

    const timestamp = Number.parseInt(path.parse(entry).name, 10);
    if (Number.isNaN(timestamp)) continue;

    frames.push({
      timestamp,
      filePath: path.join(heatmapDir, entry),
    });
  }

  frames.sort((a, b) => a.timestamp - b.timestamp);
  return frames;
}

async function replayFromHeatmaps(
  tradeController: TradeController,
  heatmapDir: string,
  heatmapOptions: HeatmapAnalyzerOptions,
  heatmapAnalyzerAgent: 'nodejs' | 'python',
  concurrencyLimit: number
) {
  const frames = await loadHeatmapFrames(heatmapDir);

  if (frames.length === 0) return;

  const concurrency = Math.max(1, concurrencyLimit);

  interface BufferedResult {
    timestamp: number;
    heatmap: HeatmapAnalyzerResult;
  }

  const bufferedResults = new Map<number, BufferedResult>();
  let nextToProcess = 0;
  let processingQueue = false;

  const processAvailableResults = async (): Promise<void> => {
    if (processingQueue) return;

    processingQueue = true;

    try {
      const lines: string[] = [];

      while (bufferedResults.has(nextToProcess)) {
        const { timestamp, heatmap } = bufferedResults.get(nextToProcess)!;
        bufferedResults.delete(nextToProcess);

        const sentimentScore = heatmap.sentimentScore;

        const sentimentScoreAnalysisReports = await tradeController.getSentimentScoreAnalysisReports(
          sentimentScore
        );

        lines.push(
          JSON.stringify({
            tick: {
              timestamp,
              heatmapAnalyzer: heatmap,
              ...sentimentScoreAnalysisReports,
            },
          })
        );

        nextToProcess++;
      }

      if (lines.length > 0) {
        logStream.write(lines.join('\n') + '\n');
      }
    } finally {
      processingQueue = false;
    }
  };

  const dispatchFramePython = async (agent: PythonHeatmapAgent, index: number): Promise<void> => {
    const { timestamp, filePath } = frames[index]!;
    const buffer = await fs.readFile(filePath);
    const heatmap = await agent.analyze(buffer, heatmapOptions);

    bufferedResults.set(index, { timestamp, heatmap: heatmap.heatmap.result });
    await processAvailableResults();
  };

  const dispatchFrameNodejs = async (analyzer: HeatmapAnalyzer, index: number): Promise<void> => {
    const { timestamp, filePath } = frames[index]!;
    const buffer = await fs.readFile(filePath);
    const heatmap = await analyzer.analyze(buffer);

    bufferedResults.set(index, { timestamp, heatmap });
    await processAvailableResults();
  };

  const totalFrames = frames.length;
  let cursor = 0;

  const getNextIndex = (): number | null => {
    if (cursor >= totalFrames) return null;

    const current = cursor;
    cursor += 1;
    return current;
  };

  if (heatmapAnalyzerAgent === 'python') {
    const worker = async (): Promise<void> => {
      const agent = await PythonHeatmapAgent.create(process.env.PYTHON);
      try {
        while (true) {
          const index = getNextIndex();
          if (index === null) break;

          await dispatchFramePython(agent, index);
        }
      } finally {
        await agent.dispose();
      }
    };

    const workerCount = Math.min(concurrency, totalFrames);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);
  } else {
    // Node.js analyzer - single threaded
    const analyzer = new HeatmapAnalyzer(heatmapOptions);
    for (let index = 0; index < totalFrames; index++) {
      await dispatchFrameNodejs(analyzer, index);
    }
  }

  await processAvailableResults();
}

async function loadPreset(configPresetsJson: string): Promise<TradeControllerOptions> {
  const file = path.resolve(process.cwd(), 'config', 'presets', configPresetsJson);
  const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');

  return JSON.parse(text) as TradeControllerOptions;
}

async function replayFromLog(tradeController: TradeController, sourceLogPath: string): Promise<void> {
  const logContent = await fs.readFile(sourceLogPath, 'utf8');
  const lines = logContent.split('\n').filter((line) => line.trim());

  const ticks: Array<{ timestamp: number; sentimentScore: number }> = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      const sentimentScore = parsed.tick?.heatmapAnalyzer?.result?.sentimentScore;
      const timestamp = parsed.tick?.timestamp;

      if (timestamp != null && sentimentScore != null) {
        ticks.push({
          timestamp: parsed.tick.timestamp,
          sentimentScore: sentimentScore,
        });
      }
    } catch {
      // Skip invalid lines (e.g., "started" metadata)
      continue;
    }
  }

  if (ticks.length === 0) {
    throw new Error(`No valid ticks found in ${sourceLogPath}`);
  }

  const outputLines: string[] = [];

  for (const { timestamp, sentimentScore } of ticks) {
    const sentimentScoreAnalysisReports = await tradeController.getSentimentScoreAnalysisReports(sentimentScore);

    // Create minimal HeatmapAnalyzerResult for log replay (no actual heatmap data available)
    const minimalHeatmapResult: Partial<HeatmapAnalyzerResult> = {
      sentimentScore,
      // Other fields omitted since original heatmap data is not available
    };

    outputLines.push(
      JSON.stringify({
        tick: {
          timestamp,
          heatmapAnalyzer: { result: minimalHeatmapResult },
          ...sentimentScoreAnalysisReports,
        },
      })
    );
  }

  logStream.write(outputLines.join('\n') + '\n');
}

async function replay(
  controllerRecordsDirectory: string,
  configPresetsJson: string,
  mode: 'heatmap' | 'log',
  concurrencyLimit: number
): Promise<void> {
  const timestamp = Date.now();

  const tradeControllerOptions = await loadPreset(configPresetsJson);
  tradeControllerOptions.isLoggingEnabled = false;

  // Extract serviceTimestamp from directory name: trade-controller-1_1761756068332_1761756068032
  const match = /^(.+)_(\d+)_(\d+)$/.exec(controllerRecordsDirectory);
  if (!match) {
    throw new Error(
      `Invalid controller directory name format: ${controllerRecordsDirectory}. Expected format: trade-controller-<id>_<timestamp>_<serviceTimestamp>`
    );
  }
  const serviceTimestamp = Number.parseInt(match[3]!, 10);

  const tradeController = new TradeController(tradeControllerOptions, serviceTimestamp);

  // New directory structure: heatmaps partitioned by serviceTimestamp, logs are per-controller
  const logsDirectoryPath = path.join('records', 'trade-manager', 'trade-controllers', controllerRecordsDirectory);
  const heatmapDir = path.join('records', 'trade-manager', 'heatmaps', serviceTimestamp.toString());
  const logPath = path.join(logsDirectoryPath, `log-replay-${timestamp}.log`);

  console.log(`Starting replay: ${logPath}`);

  const started = {
    timestamp: timestamp,
    logsDirectoryPath: logsDirectoryPath,
    options: tradeControllerOptions,
  };

  logStream = createWriteStream(logPath, { flags: 'a' });

  logStream.write(JSON.stringify({ started }) + '\n');

  if (mode === 'log') {
    const sourceLogPath = path.join(logsDirectoryPath, 'log.log');
    console.log(`Replaying from log: ${sourceLogPath}`);
    await replayFromLog(tradeController, sourceLogPath);
  } else if (mode === 'heatmap') {
    console.log(`Replaying from heatmaps: ${heatmapDir}`);
    const heatmapAnalyzerAgent = tradeControllerOptions.heatmapAnalyzerAgent ?? 'nodejs';
    console.log(`Using ${heatmapAnalyzerAgent} heatmap analyzer`);
    await replayFromHeatmaps(
      tradeController,
      heatmapDir,
      tradeControllerOptions.heatmapAnalyzerOptions,
      heatmapAnalyzerAgent,
      concurrencyLimit
    );
  } else {
    throw new Error(`Invalid mode: ${mode}. This should never happen due to validation in main().`);
  }

  console.log('Replay complete.');
}

async function main(): Promise<void> {
  dotenv.config();

  const [recordsControllerDirectory, configPresetsJson, modeArg] = process.argv.slice(2);

  if (!recordsControllerDirectory || !configPresetsJson || !modeArg) {
    console.error('Usage: npm run replay -- <records-controller-directory> <config-presets-json> <mode>');
    console.error('  mode: "heatmap" or "log"');
    console.error('  - heatmap: Re-analyze heatmap images (slower, for testing heatmap settings)');
    console.error('  - log: Reuse sentiment scores from log.log (faster, for testing analyzer settings)');

    process.exitCode = 1;

    return;
  }

  if (modeArg !== 'heatmap' && modeArg !== 'log') {
    console.error(`Invalid mode: "${modeArg}". Must be "heatmap" or "log".`);
    process.exitCode = 1;
    return;
  }

  const mode: 'heatmap' | 'log' = modeArg;

  const requestedConcurrency = Number.parseInt(process.env.HEATMAP_REPLAY_CONCURRENCY_LIMIT ?? '1', 10);
  const hardwareConcurrency =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

  const concurrencyLimit = requestedConcurrency > 0 ? requestedConcurrency : hardwareConcurrency;

  await replay(recordsControllerDirectory, configPresetsJson, mode, concurrencyLimit);
}

if (isMainThread) {
  await main();
}
