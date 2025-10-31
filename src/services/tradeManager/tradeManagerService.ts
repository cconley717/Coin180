import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { TradeController } from './tradeController.js';
import type { TradeControllerOptions } from './core/options.js';

export class TradeManagerService extends EventEmitter {
  private readonly controllers: Map<string, TradeController> = new Map();
  private browser: Browser | null = null;
  private page: Page | null = null;
  private tickTimeoutId: NodeJS.Timeout | null = null;
  private runningTick: Promise<void> | null = null;
  private readonly url = 'https://coin360.com/?period=1h';
  private readonly captureInterval = 5000;
  private isRunning = false;
  private readonly heatmapsDirectoryPath: string;
  private readonly serviceTimestamp: number;

  constructor() {
    super();
    
    // Service creation timestamp for partitioning heatmaps
    this.serviceTimestamp = Date.now();
    
    // Centralized heatmap storage: records/trade-manager/heatmaps/<serviceTimestamp>
    const recordsPath = path.join(process.cwd(), 'records');
    this.heatmapsDirectoryPath = path.join(recordsPath, 'trade-manager', 'heatmaps', this.serviceTimestamp.toString());
    
    // Create heatmaps subdirectory on initialization
    fs.mkdirSync(this.heatmapsDirectoryPath, { recursive: true });
  }

  /**
   * Start the shared Puppeteer browser and begin capturing heatmaps
   */
  public async startCapture(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.browser = await puppeteer.launch();
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('canvas');

    this.isRunning = true;
    this.scheduleNextTick(this.captureInterval);

    this.emit('capture-started', { timestamp: Date.now() });
  }

  /**
   * Stop the shared Puppeteer browser
   */
  public async stopCapture(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.tickTimeoutId) {
      clearTimeout(this.tickTimeoutId);
      this.tickTimeoutId = null;
    }

    if (this.runningTick) {
      try {
        await this.runningTick;
      } catch {
        // Ignore errors from in-flight tick during shutdown
      }
      this.runningTick = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }

    this.emit('capture-stopped', { timestamp: Date.now() });
  }

  /**
   * Capture heatmap and distribute to all active controllers
   */
  private async tick(): Promise<void> {
    try {
      if (!this.page) {
        return;
      }

      const dataUrl: string = await this.page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas ? canvas.toDataURL() : '';
      });

      if (!dataUrl) {
        return;
      }

      const timestamp = Date.now();
      const pngImageBuffer = this.getPngImageBuffer(dataUrl);

      // Distribute PNG buffer to all active controllers
      const tickPromises: Promise<void>[] = [];
      for (const controller of this.controllers.values()) {
        if (controller.isActive()) {
          tickPromises.push(
            controller.analyzeTick(pngImageBuffer, timestamp).catch((err) => {
              console.error(`Error in controller ${controller.getIdentifier()}:`, err);
            })
          );
        }
      }

      // Only save heatmap if there are active controllers
      if (tickPromises.length > 0) {
        const heatmapFilePath = path.join(this.heatmapsDirectoryPath, `${timestamp}.png`);
        fs.writeFileSync(heatmapFilePath, pngImageBuffer);
      }

      await Promise.all(tickPromises);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.runningTick = null;
      if (this.isRunning) {
        this.scheduleNextTick(this.captureInterval);
      }
    }
  }

  private getPngImageBuffer(dataUrl: string): Buffer {
    const base64String = dataUrl.substring(
      dataUrl.indexOf('data:image/png;base64,') + 22
    );
    return Buffer.from(base64String, 'base64');
  }

  private scheduleNextTick(delay: number): void {
    if (this.tickTimeoutId) {
      clearTimeout(this.tickTimeoutId);
    }

    this.tickTimeoutId = setTimeout(() => {
      this.tickTimeoutId = null;
      this.runningTick = this.tick();
    }, delay);
  }

  /**
   * Add a new TradeController (does not auto-start it)
   */
  public addTradeController(tradeControllerOptions: TradeControllerOptions): TradeController {
    if (!tradeControllerOptions) {
      throw new Error('TradeControllerOptions must be provided.');
    }

    const controller = new TradeController(tradeControllerOptions, this.serviceTimestamp);
    const key = `${controller.getIdentifier()}_${controller.getTimestamp()}_${this.serviceTimestamp}`;

    this.controllers.set(key, controller);

    return controller;
  }

  /**
   * Start a specific controller
   */
  public async startController(controller: TradeController): Promise<void> {
    await controller.start();
  }

  /**
   * Stop a specific controller
   */
  public async stopController(controller: TradeController): Promise<void> {
    await controller.stop();
  }

  /**
   * Remove a controller from management
   */
  public removeTradeController(controller: TradeController): void {
    const key = `${controller.getIdentifier()}_${controller.getTimestamp()}_${controller.getServiceTimestamp()}`;
    this.controllers.delete(key);
  }

  /**
   * Get a controller by identifier, timestamp, and serviceTimestamp
   */
  public getController(identifier: string, timestamp: number, serviceTimestamp: number): TradeController | undefined {
    return this.controllers.get(`${identifier}_${timestamp}_${serviceTimestamp}`);
  }

  /**
   * Get all controllers
   */
  public getAllControllers(): TradeController[] {
    return Array.from(this.controllers.values());
  }

  /**
   * Check if capture is running
   */
  public isCaptureRunning(): boolean {
    return this.isRunning;
  }
}
