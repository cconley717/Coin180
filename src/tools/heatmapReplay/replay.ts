import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import type { TradeControllerOptions } from '../../services/tradeManager/core/options.js';
import { TradeController } from '../../services/tradeManager/tradeController.js';

interface HeatmapFrameMeta {
    timestamp: number;
    filePath: string;
}

interface HeatmapFrameResult {
    timestamp: number;
    heatmapAnalysisReport: unknown;
}

async function* iterateHeatmaps(heatmapDir: string): AsyncGenerator<{ timestamp: number; buffer: Buffer }> {
    const heatmaps = await fs.readdir(heatmapDir);

    for (const heatmap of heatmaps) {
        const timestamp = Number.parseInt(path.parse(heatmap).name, 10);

        const buffer = await fs.readFile(path.join(heatmapDir, heatmap));

        yield { buffer, timestamp };
    }
}

async function loadHeatmapFrames(heatmapDir: string): Promise<HeatmapFrameMeta[]> {
    const entries = await fs.readdir(heatmapDir);

    const frames: HeatmapFrameMeta[] = [];
    for (const entry of entries) {
        const timestamp = Number.parseInt(path.parse(entry).name, 10);

        frames.push({
            timestamp,
            filePath: path.join(heatmapDir, entry)
        });
    }

    return frames;
}

async function processHeatmapsSynchronously(tradeController: TradeController, heatmapDir: string, logPath: string) {
    for await (const { buffer, timestamp } of iterateHeatmaps(heatmapDir)) {
        const result = await tradeController.analyzeRawHeatmap(buffer, timestamp);

        await fs.appendFile(logPath, JSON.stringify({ tick: result }) + '\n');
    }
}

async function processHeatmapsAsynchronously(tradeController: TradeController, heatmapDir: string, logPath: string) {
    const frames = await loadHeatmapFrames(heatmapDir);

    const tasks = frames.map(async ({ timestamp, filePath }) => {
        const buffer = await fs.readFile(filePath);
        const heatmapAnalysisReport = await tradeController.getHeatmapAnalysisReport(buffer);

        return { timestamp, heatmapAnalysisReport } satisfies HeatmapFrameResult;
    });

    const results = await Promise.all(tasks);

    results.sort((a, b) => a.timestamp - b.timestamp);

    for (const { timestamp, heatmapAnalysisReport } of results) {
        const sentimentScoreAnalysisReports = await tradeController.getSentimentScoreAnalysisReports(heatmapAnalysisReport.heatmap.result.sentimentScore);

        await fs.appendFile(logPath, JSON.stringify({ tick: { timestamp, ...heatmapAnalysisReport, ...sentimentScoreAnalysisReports } }) + '\n');
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
        await processHeatmapsAsynchronously(tradeController, heatmapDir, logPath);
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

await main();
