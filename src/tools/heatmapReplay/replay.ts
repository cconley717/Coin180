import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainThread } from 'node:worker_threads';

import { Piscina } from 'piscina';

import type {
    HeatmapAnalyzerDebug,
    HeatmapAnalyzerResult
} from '../../services/tradeManager/core/types.js';
import type {
    HeatmapAnalyzerOptions,
    TradeControllerOptions
} from '../../services/tradeManager/core/options.js';
import { HeatmapAnalyzer } from '../../services/tradeManager/analyzers/heatmapAnalyzer.js';
import { TradeController } from '../../services/tradeManager/tradeController.js';

interface HeatmapFrameMeta {
    timestamp: number;
    filePath: string;
}

interface HeatmapWorkerPayload {
    timestamp: number;
    filePath: string;
    options: HeatmapAnalyzerOptions;
}

interface HeatmapWorkerResult {
    timestamp: number;
    heatmap: {
        result: HeatmapAnalyzerResult;
        debug: HeatmapAnalyzerDebug | null;
    };
}

export default async function heatmapWorkerTask(
    payload: HeatmapWorkerPayload
): Promise<HeatmapWorkerResult> {
    const { timestamp, filePath, options } = payload;
    const buffer = await fs.readFile(filePath);
    const analyzer = new HeatmapAnalyzer(structuredClone(options));
    const result = await analyzer.analyze(buffer);

    return {
        timestamp,
        heatmap: {
            result,
            debug: analyzer.getDebugSnapshot()
        }
    };
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

async function processHeatmapsSynchronously(
    tradeController: TradeController,
    heatmapDir: string,
    logPath: string
) {
    const frames = await loadHeatmapFrames(heatmapDir);

    for (const { timestamp, filePath } of frames) {
        const buffer = await fs.readFile(filePath);
        const result = await tradeController.analyzeRawHeatmap(buffer, timestamp);

        await fs.appendFile(logPath, JSON.stringify({ tick: result }) + '\n');
    }
}

async function processHeatmapsAsynchronously(
    tradeController: TradeController,
    heatmapDir: string,
    logPath: string,
    heatmapOptions: HeatmapAnalyzerOptions
) {
    const frames = await loadHeatmapFrames(heatmapDir);

    const pool = new Piscina({
        filename: new URL(import.meta.url).href,
        execArgv: process.execArgv
    });

    const workerResults = await Promise.all(
        frames.map(frame =>
            pool.run({
                timestamp: frame.timestamp,
                filePath: frame.filePath,
                options: structuredClone(heatmapOptions)
            } satisfies HeatmapWorkerPayload)
        )
    ) as HeatmapWorkerResult[];

    await pool.destroy();

    workerResults.sort((a, b) => a.timestamp - b.timestamp);

    for (const { timestamp, heatmap } of workerResults) {
        const sentimentScoreAnalysisReports =
            await tradeController.getSentimentScoreAnalysisReports(heatmap.result.sentimentScore);

        await fs.appendFile(
            logPath,
            JSON.stringify({
                tick: {
                    timestamp,
                    heatmap,
                    ...sentimentScoreAnalysisReports
                }
            }) + '\n'
        );
    }
}

async function loadPreset(configPresetsJson: string): Promise<TradeControllerOptions> {
    const file = path.resolve(process.cwd(), 'config', 'presets', configPresetsJson);
    const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');

    return JSON.parse(text) as TradeControllerOptions;
}

async function replay(controllerRecordsDirectory: string, configPresetsJson: string, mode: string): Promise<void> {
    const timestamp = Date.now();

    const tradeControllerOptions = await loadPreset(configPresetsJson);
    tradeControllerOptions.isLoggingEnabled = false;

    const tradeController = new TradeController(tradeControllerOptions);

    const logsDirectoryPath = path.join('records', controllerRecordsDirectory);
    const heatmapDir = path.join(logsDirectoryPath, 'heatmaps');
    const logPath = path.join(logsDirectoryPath, `log-replay-${timestamp}.log`);

    console.log(`Starting replay: ${logPath}`);

    const started = {
        timestamp: timestamp,
        logsDirectoryPath: logsDirectoryPath,
        options: tradeControllerOptions
    }

    await fs.appendFile(logPath, JSON.stringify({ started }) + '\n');

    if(mode === 'sync') {
        await processHeatmapsSynchronously(tradeController, heatmapDir, logPath);
    }
    else if(mode === 'async') {
        await processHeatmapsAsynchronously(
            tradeController,
            heatmapDir,
            logPath,
            tradeControllerOptions.heatmapAnalyzerOptions
        );
    }

    console.log('Replay complete.');
}

async function main(): Promise<void> {
    const [recordsControllerDirectory, configPresetsJson, mode] = process.argv.slice(2);

    if (!recordsControllerDirectory || !configPresetsJson || !mode) {
        // npm run replay -- trade-controller-1_1761576768531 test.json sync
        console.error('Usage: npm run replay -- <records-controller-directory> <config-presets-json> <sync || async>');

        process.exitCode = 1;

        return;
    }

    await replay(recordsControllerDirectory, configPresetsJson, mode);
}

if (isMainThread) {
    await main();
}
