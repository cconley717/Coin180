import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainThread } from 'node:worker_threads';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { Piscina } from 'piscina';
import { once } from 'node:events';

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

interface PythonHeatmapResponse {
    timestamp?: number;
    heatmap?: HeatmapWorkerResult['heatmap'];
    error?: string;
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

async function processHeatmapsAsynchronously_CPU(
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

class PythonHeatmapAgent {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly rl: readline.Interface;
    private disposed = false;

    private constructor(child: ChildProcessWithoutNullStreams) {
        this.child = child;
        this.rl = readline.createInterface({
            input: child.stdout,
            crlfDelay: Number.POSITIVE_INFINITY
        });

        child.stderr.on('data', chunk => {
            const message = chunk.toString().trim();
            if (message.length > 0) {
                console.error(`[python-agent] ${message}`);
            }
        });
    }

    public static async create(pythonExecutable?: string): Promise<PythonHeatmapAgent> {
        const scriptPath = path.resolve(process.cwd(), 'python', 'heatmap_service', 'main.py');
        const child = spawn(pythonExecutable ?? 'python', [scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        child.on('error', err => {
            console.error('Python agent failed to start:', err);
        });

        return new PythonHeatmapAgent(child);
    }

    private waitForLine(): Promise<string> {
        return new Promise((resolve, reject) => {
            let settled = false;

            const cleanup = () => {
                this.rl.off('line', handleLine);
                this.rl.off('close', handleClose);
                this.child.off('exit', handleExit);
                this.child.off('error', handleError);
            };

            const handleLine = (line: string) => {
                if (settled)
                    return;

                settled = true;
                cleanup();
                resolve(line);
            };

            const handleClose = () => {
                if (settled)
                    return;

                settled = true;
                cleanup();
                reject(new Error('Python agent stdout closed unexpectedly.'));
            };

            const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
                if (settled)
                    return;

                settled = true;
                cleanup();
                reject(new Error(`Python agent exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`));
            };

            const handleError = (error: Error) => {
                if (settled)
                    return;

                settled = true;
                cleanup();
                reject(error);
            };

            this.rl.once('line', handleLine);
            this.rl.once('close', handleClose);
            this.child.once('exit', handleExit);
            this.child.once('error', handleError);
        });
    }

    public async analyze(
        buffer: Buffer,
        timestamp: number,
        options: HeatmapAnalyzerOptions
    ): Promise<HeatmapWorkerResult> {
        if (this.disposed) {
            throw new Error('Python agent has already been disposed.');
        }

        const payload = JSON.stringify({
            timestamp,
            pngBase64: buffer.toString('base64'),
            options: structuredClone(options)
        });

        const linePromise = this.waitForLine();
        this.child.stdin.write(payload + '\n');

        const line = await linePromise;
        const response = JSON.parse(line) as PythonHeatmapResponse;
        if (response.error) {
            throw new Error(`Python agent error: ${response.error}`);
        }

        if (!response.heatmap) {
            throw new Error('Python agent did not return a heatmap payload.');
        }

        return {
            timestamp: typeof response.timestamp === 'number' ? response.timestamp : timestamp,
            heatmap: {
                result: response.heatmap.result,
                debug: response.heatmap.debug ?? null
            }
        };
    }

    public async dispose(): Promise<void> {
        if (this.disposed)
            return;

        this.disposed = true;
        this.rl.close();

        if (!this.child.killed) {
            this.child.stdin.end();
            this.child.kill();
        }

        if (this.child.exitCode === null && this.child.signalCode === null) {
            try {
                await once(this.child, 'exit');
            }
            catch {
                // Process may have already exited; ignore.
            }
        }
    }
}

async function processHeatmapsAsynchronously_GPU(
    tradeController: TradeController,
    heatmapDir: string,
    logPath: string,
    heatmapOptions: HeatmapAnalyzerOptions
) {
    const frames = await loadHeatmapFrames(heatmapDir);

    if (frames.length === 0)
        return;

    const pythonAgent = await PythonHeatmapAgent.create(process.env.PYTHON);

    try {
        for (const { timestamp, filePath } of frames) {
            const buffer = await fs.readFile(filePath);
            const { heatmap } = await pythonAgent.analyze(
                buffer,
                timestamp,
                heatmapOptions
            );

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
    finally {
        await pythonAgent.dispose();
    }
}

async function loadPreset(configPresetsJson: string): Promise<TradeControllerOptions> {
    const file = path.resolve(process.cwd(), 'config', 'presets', configPresetsJson);
    const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');

    return JSON.parse(text) as TradeControllerOptions;
}

async function replay(
    controllerRecordsDirectory: string,
    configPresetsJson: string,
    mode: string,
    agent: string
): Promise<void> {
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
        if(agent === 'cpu') {
            await processHeatmapsAsynchronously_CPU(
                tradeController,
                heatmapDir,
                logPath,
                tradeControllerOptions.heatmapAnalyzerOptions
            );
        }
        else if(agent === 'gpu') {
            await processHeatmapsAsynchronously_GPU(
                tradeController,
                heatmapDir,
                logPath,
                tradeControllerOptions.heatmapAnalyzerOptions
            );
        }
        else {
            throw new Error(`Unsupported agent "${agent}". Expected "cpu" or "gpu".`);
        }
    }

    console.log('Replay complete.');
}

async function main(): Promise<void> {
    const [recordsControllerDirectory, configPresetsJson, mode, agentArg] = process.argv.slice(2);

    if (!recordsControllerDirectory || !configPresetsJson || !mode) {
        console.error('Usage: npm run replay -- <records-controller-directory> <config-presets-json> <sync || async> [cpu|gpu]');

        process.exitCode = 1;

        return;
    }

    const agent = (agentArg ?? 'cpu').toLowerCase();

    await replay(recordsControllerDirectory, configPresetsJson, mode, agent);
}

if (isMainThread) {
    await main();
}
