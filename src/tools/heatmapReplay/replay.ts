import fs from 'node:fs/promises';
import { createWriteStream, WriteStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isMainThread } from 'node:worker_threads';
import os from 'node:os';
import dotenv from 'dotenv';
import type {
    HeatmapAnalyzerOptions,
    TradeControllerOptions
} from '../../services/tradeManager/core/options.js';
import { TradeController } from '../../services/tradeManager/tradeController.js';
import {
    PythonHeatmapAgent,
} from '../../services/pythonHeatmap/agent.js';
import type { PythonHeatmapResult } from '../../services/tradeManager/core/types.js';

let logStream: WriteStream;

interface HeatmapFrameMeta {
    timestamp: number;
    filePath: string;
}

async function loadHeatmapFrames(heatmapDir: string): Promise<HeatmapFrameMeta[]> {
    const entries = await fs.readdir(heatmapDir);

    const frames: HeatmapFrameMeta[] = [];
    for (const entry of entries) {
        if (!entry.toLowerCase().endsWith('.png'))
            continue;

        const timestamp = Number.parseInt(path.parse(entry).name, 10);
        if (Number.isNaN(timestamp))
            continue;

        frames.push({
            timestamp,
            filePath: path.join(heatmapDir, entry)
        });
    }

    frames.sort((a, b) => a.timestamp - b.timestamp);
    return frames;
}

async function processHeatmaps(
    tradeController: TradeController,
    heatmapDir: string,
    logPath: string,
    heatmapOptions: HeatmapAnalyzerOptions,
    concurrencyLimit: number
) {
    const frames = await loadHeatmapFrames(heatmapDir);

    if (frames.length === 0)
        return;

    const concurrency = Math.max(1, concurrencyLimit);

    interface BufferedResult {
        timestamp: number;
        heatmap: PythonHeatmapResult['heatmap'];
    }

    const bufferedResults = new Map<number, BufferedResult>();
    let nextToProcess = 0;
    let processingQueue = false;

    const processAvailableResults = async (): Promise<void> => {
        if (processingQueue)
            return;

        processingQueue = true;
        
        try {
            const lines: string[] = [];

            while (bufferedResults.has(nextToProcess)) {
                const { timestamp, heatmap } = bufferedResults.get(nextToProcess)!;
                bufferedResults.delete(nextToProcess);

                const sentimentScoreAnalysisReports = await tradeController.getSentimentScoreAnalysisReports(heatmap.result.sentimentScore);

                lines.push(
                    JSON.stringify({
                        tick: {
                            timestamp,
                            heatmapAnalyzer: heatmap,
                            ...sentimentScoreAnalysisReports
                        }
                    })
                );

                nextToProcess++;
            }

            if (lines.length > 0) {
                logStream.write(lines.join('\n') + '\n');
            }
        }
        finally {
            processingQueue = false;
        }
    };

    const dispatchFrame = async (agent: PythonHeatmapAgent, index: number): Promise<void> => {
        const { timestamp, filePath } = frames[index]!;
        const buffer = await fs.readFile(filePath);
        const { heatmap } = await agent.analyze(
            buffer,
            heatmapOptions
        );

        bufferedResults.set(index, { timestamp, heatmap });
        await processAvailableResults();
    };

    const totalFrames = frames.length;
    let cursor = 0;

    const getNextIndex = (): number | null => {
        if (cursor >= totalFrames)
            return null;

        const current = cursor;
        cursor += 1;
        return current;
    };

    const worker = async (): Promise<void> => {
        const agent = await PythonHeatmapAgent.create(process.env.PYTHON);
        try {
            while (true) {
                const index = getNextIndex();
                if (index === null)
                    break;

                await dispatchFrame(agent, index);
            }
        }
        finally {
            await agent.dispose();
        }
    };

    const workerCount = Math.min(concurrency, totalFrames);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);
    await processAvailableResults();
}

async function loadPreset(configPresetsJson: string): Promise<TradeControllerOptions> {
    const file = path.resolve(process.cwd(), 'config', 'presets', configPresetsJson);
    const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');

    return JSON.parse(text) as TradeControllerOptions;
}

async function replay(
    controllerRecordsDirectory: string,
    configPresetsJson: string,
    concurrencyLimit: number
): Promise<void> {
    const timestamp = Date.now();

    const tradeControllerOptions = await loadPreset(configPresetsJson);
    tradeControllerOptions.isLoggingEnabled = false;

    // Extract serviceTimestamp from directory name: trade-controller-1_1761756068332_1761756068032
    const match = /^(.+)_(\d+)_(\d+)$/.exec(controllerRecordsDirectory);
    if (!match) {
        throw new Error(`Invalid controller directory name format: ${controllerRecordsDirectory}. Expected format: trade-controller-<id>_<timestamp>_<serviceTimestamp>`);
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
        options: tradeControllerOptions
    }

    logStream = createWriteStream(logPath, { flags: 'a' });
    
    logStream.write(JSON.stringify({ started }) + '\n');

    await processHeatmaps(
        tradeController,
        heatmapDir,
        logPath,
        tradeControllerOptions.heatmapAnalyzerOptions,
        concurrencyLimit
    );

    console.log('Replay complete.');
}

async function main(): Promise<void> {
    dotenv.config();

    const [recordsControllerDirectory, configPresetsJson] = process.argv.slice(2);

    if (!recordsControllerDirectory || !configPresetsJson) {
        console.error('Usage: npm run replay -- <records-controller-directory> <config-presets-json>');

        process.exitCode = 1;

        return;
    }

    const requestedConcurrency = Number.parseInt(process.env.HEATMAP_PROCESSING_CONCURRENCY_LIMIT ?? '1', 10);
    const hardwareConcurrency = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

    const concurrencyLimit = requestedConcurrency > 0 ? requestedConcurrency : hardwareConcurrency;

    await replay(
        recordsControllerDirectory,
        configPresetsJson,
        concurrencyLimit
    );
}

if (isMainThread) {
    await main();
}
