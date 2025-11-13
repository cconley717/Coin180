import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DeltaFilterAnalyzer } from './analyzers/deltaFilterAnalyzer.js';
import { SlopeSignAnalyzer } from './analyzers/slopeSignAnalyzer.js';
import { MomentumCompositeAnalyzer } from './analyzers/momentumCompositeAnalyzer.js';
import { TradeSignalAnalyzer } from './analyzers/tradeSignalAnalyzer.js';
import { HeatmapAnalyzer } from './analyzers/heatmapAnalyzer.js';
import type { TradeControllerOptions } from './core/options.js';
import { PythonHeatmapAgent } from '../pythonHeatmap/agent.js';
import type { HeatmapAnalysisReport } from './core/types.js';

export class TradeController extends EventEmitter {
  private readonly identifier: string;
  private readonly isLoggingEnabled: boolean;

  private readonly options: TradeControllerOptions;

  private readonly logsDirectoryPath: string;
  private readonly logFilePath: string;

  private readonly deltaFilterAnalyzer: DeltaFilterAnalyzer;
  private readonly slopeSignAnalyzer: SlopeSignAnalyzer;
  private readonly momentumCompositeAnalyzer: MomentumCompositeAnalyzer;
  private readonly tradeSignalAnalyzer: TradeSignalAnalyzer;
  private readonly nodejsHeatmapAnalyzer: HeatmapAnalyzer;

  private readonly timestamp = Date.now();
  private readonly serviceTimestamp: number;
  private readonly heatmapAnalyzerAgent: 'nodejs' | 'python';

  private pythonAgentPromise: Promise<PythonHeatmapAgent> | null = null;
  private active = false;

  constructor(options: TradeControllerOptions, serviceTimestamp: number) {
    super();

    if (!options) throw new Error('TradeController requires explicit options.');

    this.options = options;

    const identifier = (options.identifier ?? '').trim();
    if (!identifier) {
      throw new Error('TradeController: options.identifier must be a non-empty string.');
    }
    this.identifier = identifier;

    this.serviceTimestamp = serviceTimestamp;

    this.isLoggingEnabled = options.isLoggingEnabled;

    if (this.isLoggingEnabled) {
      const recordsDirectoryPath = options.recordsDirectoryPath;

      // New directory structure: records/trade-manager/trade-controllers/trade-controller-<id>_<timestamp>_<serviceTimestamp>
      this.logsDirectoryPath = path.join(
        recordsDirectoryPath,
        'trade-manager',
        'trade-controllers',
        `${this.identifier}_${this.timestamp}_${this.serviceTimestamp}`
      );
      this.logFilePath = path.join(this.logsDirectoryPath, `log.log`);

      fs.mkdirSync(this.logsDirectoryPath, { recursive: true });
    } else {
      this.logsDirectoryPath = '';
      this.logFilePath = '';
    }

    this.heatmapAnalyzerAgent = options.heatmapAnalyzerAgent ?? 'nodejs';
    this.nodejsHeatmapAnalyzer = new HeatmapAnalyzer(options.heatmapAnalyzerOptions);
    this.deltaFilterAnalyzer = new DeltaFilterAnalyzer(options.deltaFilterAnalyzerOptions);
    this.slopeSignAnalyzer = new SlopeSignAnalyzer(options.slopeSignAnalyzerOptions);
    this.momentumCompositeAnalyzer = new MomentumCompositeAnalyzer(options.momentumCompositeAnalyzerOptions);
    this.tradeSignalAnalyzer = new TradeSignalAnalyzer(options.tradeSignalAnalyzerOptions);
  }

  /** Start the controller (initializes Python agent, logs started event) */
  public async start(): Promise<void> {
    if (this.active) {
      return;
    }

    this.active = true;

    const started = {
      timestamp: this.timestamp,
      logsDirectoryPath: this.logsDirectoryPath,
      options: this.options,
    };

    if (this.isLoggingEnabled) {
      fs.appendFileSync(this.logFilePath, JSON.stringify({ started }) + '\n');
    }

    this.emit('started', started);
  }

  /** Stop the controller */
  public async stop(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;

    if (this.pythonAgentPromise) {
      const agent = await this.pythonAgentPromise;
      await agent.dispose();
      this.pythonAgentPromise = null;
    }

    this.emit('stopped', { timestamp: Date.now() });
  }

  /**
   * Analyze a tick with the provided PNG buffer
   * Called by TradeManagerService with shared heatmap capture
   */
  public async analyzeTick(pngImageBuffer: Buffer, timestamp: number): Promise<void> {
    try {
      const result = await this.analyzeRawHeatmap(pngImageBuffer, timestamp);

      if (this.isLoggingEnabled) {
        fs.appendFileSync(this.logFilePath, JSON.stringify({ tick: result }) + '\n');
      }

      this.emit('tick', result);
    } catch (err) {
      this.emit('error', err);
    }
  }

  private async getPythonHeatmapAgent(): Promise<PythonHeatmapAgent> {
    this.pythonAgentPromise ??= PythonHeatmapAgent.create(process.env.PYTHON);

    return this.pythonAgentPromise;
  }

  public async getHeatmapAnalysisReport(
    pngImageBuffer: Buffer
  ): Promise<HeatmapAnalysisReport> {
    if (this.heatmapAnalyzerAgent === 'python') {
      const agent = await this.getPythonHeatmapAgent();
      const result = await agent.analyze(pngImageBuffer, this.options.heatmapAnalyzerOptions);
      return { heatmap: result.heatmap.result, debug: result.heatmap.debug };
    } else {
      const result = await this.nodejsHeatmapAnalyzer.analyze(pngImageBuffer);
      return { heatmap: result, debug: this.nodejsHeatmapAnalyzer.getDebugSnapshot() };
    }
  }

  public async getSentimentScoreAnalysisReports(sentimentScore: number) {
    const deltaFilteredSentimentScore = this.deltaFilterAnalyzer.update(sentimentScore);

    const slopeSignTradeSignal = this.slopeSignAnalyzer.update(deltaFilteredSentimentScore);
    const momentumCompositeTradeSignal = this.momentumCompositeAnalyzer.update(deltaFilteredSentimentScore);

    const tradeSignals = {
      slopeSignTradeSignal,
      momentumCompositeTradeSignal,
      sentimentScore,
    };

    const tradeSignalAnalyzerResult = this.tradeSignalAnalyzer.update(tradeSignals);

    return {
      deltaFilterAnalyzer: {
        result: deltaFilteredSentimentScore,
        debug: this.deltaFilterAnalyzer.getDebugSnapshot(),
      },
      slopeSignAnalyzer: {
        result: slopeSignTradeSignal,
        debug: this.slopeSignAnalyzer.getDebugSnapshot(),
      },
      momentumCompositeAnalyzer: {
        result: momentumCompositeTradeSignal,
        debug: this.momentumCompositeAnalyzer.getDebugSnapshot(),
      },
      tradeSignalFusion: {
        result: tradeSignalAnalyzerResult,
        debug: this.tradeSignalAnalyzer.getDebugSnapshot(),
      },
    };
  }

  public async analyzeRawHeatmap(pngImageBuffer: Buffer, timestamp: number) {
    const heatmapAnalysisReport = await this.getHeatmapAnalysisReport(pngImageBuffer);
    
    const sentimentScore = heatmapAnalysisReport.heatmap.sentimentScore

    const sentimentScoreAnalysisReports = await this.getSentimentScoreAnalysisReports(sentimentScore);

    const result = {
      timestamp,
      heatmapAnalyzer: { result: heatmapAnalysisReport.heatmap, debug: heatmapAnalysisReport.debug },
      ...sentimentScoreAnalysisReports,
    };

    return result;
  }

  /** Get the unique identifier for this controller */
  public getIdentifier(): string {
    return this.identifier;
  }

  /** Get the creation timestamp for this controller */
  public getTimestamp(): number {
    return this.timestamp;
  }

  /** Get the service timestamp (TradeManagerService creation timestamp) */
  public getServiceTimestamp(): number {
    return this.serviceTimestamp;
  }

  /** Check if the controller is currently active */
  public isActive(): boolean {
    return this.active;
  }
}
