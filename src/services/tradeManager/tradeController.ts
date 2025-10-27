import { EventEmitter } from 'node:events';
import puppeteer, { Browser, Page } from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { HeatmapAnalyzer } from './analyzers/heatmapAnalyzer.js';
import { DeltaFilterAnalyzer } from './analyzers/deltaFilterAnalyzer.js';
import { SlopeSignAnalyzer } from './analyzers/slopeSignAnalyzer.js';
import { MomentumCompositeAnalyzer } from './analyzers/momentumCompositeAnalyzer.js';
import { MovingAverageAnalyzer } from './analyzers/movingAverageAnalyzer.js';
import { TradeSignalAnalyzer } from './analyzers/tradeSignalAnalyzer.js';
import type { TradeControllerOptions } from './core/options.js';

export class TradeController extends EventEmitter {
    private readonly url: string;
    private readonly captureInterval: number;
    private readonly identifier: string;
    private readonly isLoggingEnabled: boolean;

    private readonly options: TradeControllerOptions;

    private readonly logsDirectoryPath: string;
    private readonly logFilePath: string;
    private readonly heatmapDirectoryPath: string;

    private readonly heatmapAnalyzer: HeatmapAnalyzer;
    private readonly deltaFilterAnalyzer: DeltaFilterAnalyzer;
    private readonly slopeSignAnalyzer: SlopeSignAnalyzer;
    private readonly momentumCompositeAnalyzer: MomentumCompositeAnalyzer;
    private readonly movingAverageAnalyzer: MovingAverageAnalyzer;
    private readonly tradeSignalAnalyzer: TradeSignalAnalyzer;

    private readonly timestamp = Date.now();

    private browser: Browser | null = null;
    private page: Page | null = null;
    private intervalId: NodeJS.Timeout | null = null;

    constructor(options: TradeControllerOptions) {
        super();

        if (!options)
            throw new Error('TradeController requires explicit options.');

        this.options = options;

        const identifier = (options.identifier ?? '').trim();
        if (!identifier) {
            throw new Error('TradeController: options.identifier must be a non-empty string.');
        }
        this.identifier = identifier;

        this.isLoggingEnabled = options.isLoggingEnabled;

        if (this.isLoggingEnabled) {
            const recordsDirectoryPath = options.recordsDirectoryPath;

            this.logsDirectoryPath = path.join(recordsDirectoryPath, `${this.identifier}_${this.timestamp}`);
            this.logFilePath = path.join(this.logsDirectoryPath, `log.txt`);

            this.heatmapDirectoryPath = path.join(recordsDirectoryPath, `${this.identifier}_${this.timestamp}`, 'heatmaps');

            fs.mkdirSync(this.logsDirectoryPath, { recursive: true });
            fs.mkdirSync(this.heatmapDirectoryPath, { recursive: true });
        }
        else {
            this.logsDirectoryPath = '';
            this.logFilePath = '';
            this.heatmapDirectoryPath = '';
        }

        this.url = options.url;
        this.captureInterval = options.captureInterval;
        this.heatmapAnalyzer = new HeatmapAnalyzer(options.heatmapAnalyzerOptions);
        this.deltaFilterAnalyzer = new DeltaFilterAnalyzer(options.deltaFilterAnalyzerOptions);
        this.slopeSignAnalyzer = new SlopeSignAnalyzer(options.slopeSignAnalyzerOptions);
        this.momentumCompositeAnalyzer = new MomentumCompositeAnalyzer(options.momentumCompositeAnalyzerOptions);
        this.movingAverageAnalyzer = new MovingAverageAnalyzer(options.movingAverageAnalyzerOptions);
        this.tradeSignalAnalyzer = new TradeSignalAnalyzer(options.tradeSignalAnalyzerOptions);
    }

    /** Start Puppeteer and begin periodic analysis */
    public async start(): Promise<void> {
        if (this.intervalId)
            return;

        this.browser = await puppeteer.launch();

        this.page = await this.browser.newPage();

        await this.page.setViewport({ width: 1920, height: 1080 });
        await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
        await this.page.waitForSelector('canvas');

        this.intervalId = setInterval(() => this.tick(), this.captureInterval);

        const started = {
            timestamp: this.timestamp,
            logsDirectoryPath: this.logsDirectoryPath,
            options: this.options
        }

        if (this.isLoggingEnabled) {
            fs.appendFileSync(this.logFilePath, JSON.stringify({ started }) + '\n');
        }

        this.emit('started', started);
    }

    /** Stop the periodic capture */
    public async stop(): Promise<void> {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }

        this.emit('stopped', { timestamp: Date.now() });
    }

    /** Perform one cycle of heatmap capture + analysis + trade decision */
    private async tick(): Promise<void> {
        try {
            if (!this.page)
                return;

            const dataUrl: string = await this.page.evaluate(() => {
                const canvas = document.querySelector('canvas');
                return canvas ? canvas.toDataURL() : '';
            });

            if (!dataUrl)
                return;

            const timestamp = Date.now();

            const pngImageBuffer = this.getPngImageBuffer(dataUrl);

            if (this.isLoggingEnabled) {
                const heatmapFilePath = path.join(this.heatmapDirectoryPath, `${timestamp}.png`);
                fs.writeFileSync(heatmapFilePath, pngImageBuffer);
            }

            const result = await this.analyzeRawHeatmap(pngImageBuffer, timestamp);

            if (this.isLoggingEnabled) {
                fs.appendFileSync(this.logFilePath, JSON.stringify({ tick: result }) + '\n');
            }

            this.emit('tick', result);
        } catch (err) {
            this.emit('error', err);
        }
    }

    private getPngImageBuffer(dataUrl: string): Buffer {
        const base64String = dataUrl.substring(
            dataUrl.indexOf('data:image/png;base64,') + 22
        );
        return Buffer.from(base64String, 'base64');
    }

    public async analyzeRawHeatmap(pngImageBuffer: Buffer, timestamp: number) {
        const heatmapAnalysis = await this.heatmapAnalyzer.analyze(pngImageBuffer);
        const sentimentScore = heatmapAnalysis.sentimentScore;

        const deltaFilteredSentimentScore = this.deltaFilterAnalyzer.update(sentimentScore);

        const slopeSignTradeSignal = this.slopeSignAnalyzer.update(deltaFilteredSentimentScore);
        const momentumCompositeTradeSignal = this.momentumCompositeAnalyzer.update(deltaFilteredSentimentScore);
        const movingAverageTradeSignal = this.movingAverageAnalyzer.update(deltaFilteredSentimentScore);

        const tradeSignals = {
            slopeSignTradeSignal,
            momentumCompositeTradeSignal,
            movingAverageTradeSignal
        };

        const tradeSignalAnalyzerResult = this.tradeSignalAnalyzer.update(tradeSignals);

        const result = {
            timestamp,
            heatmap: {
                result: heatmapAnalysis,
                debug: this.heatmapAnalyzer.getDebugSnapshot(),
            },
            deltaFilter: {
                filteredScore: deltaFilteredSentimentScore,
                debug: this.deltaFilterAnalyzer.getDebugSnapshot()
            },
            slopeSignAnalyzer: {
                result: slopeSignTradeSignal,
                debug: this.slopeSignAnalyzer.getDebugSnapshot()
            },
            momentumCompositeAnalyzer: {
                result: momentumCompositeTradeSignal,
                debug: this.momentumCompositeAnalyzer.getDebugSnapshot()
            },
            movingAverageAnalyzer: {
                result: movingAverageTradeSignal,
                debug: this.movingAverageAnalyzer.getDebugSnapshot()
            },
            tradeSignalFusion: {
                result: tradeSignalAnalyzerResult,
                debug: this.tradeSignalAnalyzer.getDebugSnapshot()
            }
        };

        return result;
    }
}
