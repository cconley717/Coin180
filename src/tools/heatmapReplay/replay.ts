import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainThread } from 'node:worker_threads';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { once } from 'node:events';

import type {
    HeatmapAnalyzerDebug,
    HeatmapAnalyzerResult
} from '../../services/tradeManager/core/types.js';
import type {
    HeatmapAnalyzerOptions,
    TradeControllerOptions
} from '../../services/tradeManager/core/options.js';
import { TradeController } from '../../services/tradeManager/tradeController.js';

interface HeatmapFrameMeta {
    timestamp: number;
    filePath: string;
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

async function loadEnvFile(filePath: string): Promise<void> {
    try {
        const text = await fs.readFile(filePath, 'utf8');
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (line.length === 0 || line.startsWith('#'))
                continue;

            const equalsIndex = line.indexOf('=');
            if (equalsIndex === -1)
                continue;

            const key = line.slice(0, equalsIndex).trim();
            const value = line.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');

            if (!key)
                continue;

            if (process.env[key] && process.env[key] !== value) {
                throw new Error(`Environment variable conflict for "${key}": existing value differs from .env (${filePath}).`);
            }

            process.env[key] = value;
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
}

async function loadEnvironment(): Promise<void> {
    const cwd = process.cwd();
    await loadEnvFile(path.join(cwd, '.env'));
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
        heatmap: HeatmapWorkerResult['heatmap'];
    }

    const bufferedResults = new Map<number, BufferedResult>();
    let nextToProcess = 0;
    let processingQueue = false;

    const processAvailableResults = async (): Promise<void> => {
        if (processingQueue)
            return;

        processingQueue = true;
        try {
            while (bufferedResults.has(nextToProcess)) {
                const { timestamp, heatmap } = bufferedResults.get(nextToProcess)!;
                bufferedResults.delete(nextToProcess);

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

                nextToProcess++;
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
            timestamp,
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
    await loadEnvironment();

    const [recordsControllerDirectory, configPresetsJson] = process.argv.slice(2);

    if (!recordsControllerDirectory || !configPresetsJson) {
        console.error('Usage: npm run replay -- <records-controller-directory> <config-presets-json>');

        process.exitCode = 1;

        return;
    }

    const concurrencyLimit = Math.max(
        1,
        Number.parseInt(process.env.HEATMAP_PROCESSING_CONCURRENCY_LIMIT ?? '1', 10)
    );

    await replay(
        recordsControllerDirectory,
        configPresetsJson,
        concurrencyLimit
    );
}

if (isMainThread) {
    await main();
}
