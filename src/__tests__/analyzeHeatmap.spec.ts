import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HeatmapAnalyzer } from '../services/tradeManager/analyzers/heatmapAnalyzer.js';
import { TradeController } from '../services/tradeManager/tradeController.js';
import type { HeatmapAnalyzerOptions, TradeControllerOptions } from '../services/tradeManager/core/options.js';

const TradeControllerOptionsPresetPath = path.resolve(process.cwd(), 'config/presets/default.json');
const TradeControllerOptionsPresetRaw = fs
  .readFileSync(TradeControllerOptionsPresetPath, 'utf8')
  .replace(/^\uFEFF/, '');
const TradeControllerOptionsPreset = JSON.parse(TradeControllerOptionsPresetRaw) as TradeControllerOptions;
const heatmapAnalyzerOptions: HeatmapAnalyzerOptions = TradeControllerOptionsPreset.heatmapAnalyzerOptions;
const heatmapAnalyzer = new HeatmapAnalyzer(heatmapAnalyzerOptions);

describe('analyzeHeatmap for proper color and color magnitude detection', () => {
  it('should detect light green with a sentiment of 33', async () => {
    const result = await heatmapAnalyzer.analyze(fs.readFileSync(path.join(__dirname, 'test_data', 'green_1.png')));

    const score = result.sentimentScore;

    expect(score).toBe(33);
  });

  it('should detect medium green with a sentiment of 67', async () => {
    const result = await heatmapAnalyzer.analyze(fs.readFileSync(path.join(__dirname, 'test_data', 'green_2.png')));

    const score = result.sentimentScore;

    expect(score).toBe(67);
  });

  it('should detect dark green with a sentiment of 100', async () => {
    const result = await heatmapAnalyzer.analyze(fs.readFileSync(path.join(__dirname, 'test_data', 'green_3.png')));

    const score = result.sentimentScore;

    expect(score).toBe(100);
  });

  it('should detect light red with a sentiment of -33', async () => {
    const result = await heatmapAnalyzer.analyze(fs.readFileSync(path.join(__dirname, 'test_data', 'red_1.png')));

    const score = result.sentimentScore;

    expect(score).toBe(-33);
  });

  it('should detect medium red with a sentiment of -67', async () => {
    const result = await heatmapAnalyzer.analyze(fs.readFileSync(path.join(__dirname, 'test_data', 'red_2.png')));

    const score = result.sentimentScore;

    expect(score).toBe(-67);
  });

  it('should detect dark red with a sentiment of -100', async () => {
    const result = await heatmapAnalyzer.analyze(fs.readFileSync(path.join(__dirname, 'test_data', 'red_3.png')));

    const score = result.sentimentScore;

    expect(score).toBe(-100);
  });

  it('should detect a neutral sentiment when all colors are present in equal magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_0.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(0);
  });

  it('should detect a near-neutral sentiment when all colors are present in near-equal magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_00.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(3);
  });

  it('should detect a low posititve sentiment when all colors are present and in the presense of a high light green magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_1.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(32);
  });

  it('should detect a medium posititve sentiment when all colors are present and in the presense of a high medium green magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_2.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(64);
  });

  it('should detect a high posititve sentiment when all colors are present and in the presense of a high dark green magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_3.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(97);
  });

  it('should detect a low negative sentiment when all colors are present and in the presense of a high light red magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_4.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(-32);
  });

  it('should detect a medium negative sentiment when all colors are present and in the presense of a high medium red magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_5.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(-64);
  });

  it('should detect a high negative sentiment when all colors are present and in the presense of a high dark red magnitude', async () => {
    const result = await heatmapAnalyzer.analyze(
      fs.readFileSync(path.join(__dirname, 'test_data', 'all_colors_6.png'))
    );

    const score = result.sentimentScore;

    expect(score).toBe(-96);
  });
});

describe('TradeController tick ID tracking', () => {
  it('should assign incrementing tick IDs to each tick', async () => {
    const tempDir = path.join(process.cwd(), 'temp_test');
    const controllerOptions: TradeControllerOptions = {
      ...TradeControllerOptionsPreset,
      recordsDirectoryPath: tempDir,
      isLoggingEnabled: true,
    };

    const controller = new TradeController(controllerOptions, Date.now());

    // Start the controller
    await controller.start();

    // Use an existing test PNG file
    const testPngBuffer = fs.readFileSync(path.join(__dirname, 'test_data', 'green_1.png'));

    const tickIds: number[] = [];

    // Listen for tick events
    controller.on('tick', (result) => {
      tickIds.push(result.tickId);
    });

    // Analyze multiple ticks
    const timestamp = Date.now();
    await controller.analyzeTick(testPngBuffer, timestamp);
    await controller.analyzeTick(testPngBuffer, timestamp + 1000);
    await controller.analyzeTick(testPngBuffer, timestamp + 2000);

    // Stop the controller
    await controller.stop();

    // Verify tick IDs are incrementing
    expect(tickIds).toHaveLength(3);
    expect(tickIds).toEqual([1, 2, 3]);

    // Clean up
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
