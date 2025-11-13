import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { loadChartDataFromLog } from '../services/chartDataService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class LiveController {
  // GET /live - Serve the live HTML page for real-time visualization
  static getLivePage(req: Request, res: Response): void {
    const controllerId = req.query.controllerId as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;

    if (!controllerId || !timestamp) {
      res.status(400).send('Missing parameters. Use ?controllerId=trade-controller-1&timestamp=1761756068332');
      return;
    }

    // Serve the live HTML page for real-time visualization
    res.sendFile(path.join(__dirname, '..', 'public', 'live.html'));
  }

  // GET /api/live/history - API endpoint to fetch historical data for live view
  static async getLiveHistory(req: Request, res: Response): Promise<void> {
    try {
      const controllerId = req.query.controllerId as string | undefined;
      const timestamp = req.query.timestamp as string | undefined;
      const serviceTimestamp = req.query.serviceTimestamp as string | undefined;

      if (!controllerId || !timestamp || !serviceTimestamp) {
        res
          .status(400)
          .json({ error: 'Missing parameters: controllerId, timestamp, and serviceTimestamp required' });
        return;
      }

      // New directory structure: records/trade-manager/trade-controllers/trade-controller-X_Y_Z
      const recordId = `${controllerId}_${timestamp}_${serviceTimestamp}`;
      const logDir = path.join(process.cwd(), 'records', 'trade-manager', 'trade-controllers', recordId);

      if (!fs.existsSync(logDir)) {
        res.status(404).json({ error: 'Controller record not found', data: [] });
        return;
      }

      // Find the most recent replay log, or fall back to log.log
      const logFilePath = path.join(logDir, 'log.log');

      if (!logFilePath || !fs.existsSync(logFilePath)) {
        res.json({ data: [] });
        return;
      }

      // Load chart data from the log file
      const chartData = await loadChartDataFromLog(logFilePath);

      const historicalData = {
        sentimentScore: chartData.sentimentScore,
        fusionConfidence: chartData.fusionConfidence,
        slopeConfidence: chartData.slopeConfidence,
        momentumConfidence: chartData.momentumConfidence,
      };

      res.json({ data: historicalData });
    } catch (error) {
      console.error('Error loading live history:', error);
      res.status(500).json({ error: 'Failed to load historical data' });
    }
  }

  // GET /api/live/heatmap - Serve the most recent heatmap for a controller
  static getLiveHeatmap(req: Request, res: Response): void {
    const controllerId = req.query.controllerId as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;
    const serviceTimestamp = req.query.serviceTimestamp as string | undefined;

    if (!controllerId || !timestamp || !serviceTimestamp) {
      res
        .status(400)
        .json({ error: 'Missing parameters: controllerId, timestamp, and serviceTimestamp required' });
      return;
    }

    try {
      // Find the most recent heatmap for this service timestamp
      const heatmapDir = path.join(process.cwd(), 'records', 'trade-manager', 'heatmaps', serviceTimestamp);

      if (!fs.existsSync(heatmapDir)) {
        res.status(404).json({ error: 'Heatmap directory not found' });
        return;
      }

      const files = fs.readdirSync(heatmapDir);
      const heatmapFiles = files.filter(f => f.endsWith('.png')).sort((a, b) => b.localeCompare(a)); // Sort descending to get most recent first

      if (heatmapFiles.length === 0) {
        res.status(404).json({ error: 'No heatmap files found' });
        return;
      }

      const mostRecentHeatmap = path.join(heatmapDir, heatmapFiles[0]!);
      res.sendFile(mostRecentHeatmap);
    } catch (error) {
      console.error('Error serving heatmap:', error);
      res.status(500).json({ error: 'Failed to serve heatmap' });
    }
  }
}