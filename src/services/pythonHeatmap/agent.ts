import path from 'node:path';
import process from 'node:process';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { once } from 'node:events';

import type { HeatmapAnalyzerOptions } from '../tradeManager/core/options.js';
import type { PythonHeatmapResponse, PythonHeatmapResult } from '../tradeManager/core/types.js';

export class PythonHeatmapAgent {
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
        options: HeatmapAnalyzerOptions
    ): Promise<PythonHeatmapResult> {
        if (this.disposed) {
            throw new Error('Python agent has already been disposed.');
        }

        const payload = JSON.stringify({
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
