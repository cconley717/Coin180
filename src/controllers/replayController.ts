import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { loadChartDataFromLog } from '../services/chartDataService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ReplayController {
  // GET /replay - Serve the replay HTML page
  static getReplayPage(req: Request, res: Response): void {
    const controllerId = req.query.controllerId as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;

    if (!controllerId || !timestamp) {
      res.status(400).send('Missing parameters. Use ?controllerId=trade-controller-1&timestamp=1761756068332');
      return;
    }

    // Serve the replay HTML page
    res.sendFile(path.join(__dirname, '..', 'public', 'replay.html'));
  }

  // GET /api/replay/controllers - API endpoint to list all available controller-timestamp combos
  static getReplayControllers(req: Request, res: Response): void {
    try {
      // New directory structure: records/trade-manager/trade-controllers/
      const controllersDir = path.join(process.cwd(), 'records', 'trade-manager', 'trade-controllers');

      if (!fs.existsSync(controllersDir)) {
        res.json({ controllers: [] });
        return;
      }

      const dirs = fs.readdirSync(controllersDir);
      const controllers: Array<{
        id: string;
        controllerId: string;
        timestamp: string;
        serviceTimestamp: string;
        displayName: string;
      }> = [];

      for (const dir of dirs) {
        // Match pattern: trade-controller-1_1761756068332_1761756068032
        const match = /^(.+)_(\d+)_(\d+)$/.exec(dir);
        if (match) {
          const controllerId = match[1]!;
          const timestamp = match[2]!;
          const serviceTimestamp = match[3]!;
          const date = new Date(Number.parseInt(timestamp, 10));

          controllers.push({
            id: dir,
            controllerId,
            timestamp,
            serviceTimestamp,
            displayName: `${controllerId} - ${date.toLocaleString()}`,
          });
        }
      }

      // Sort by timestamp descending (newest first)
      controllers.sort((a, b) => Number.parseInt(b.timestamp, 10) - Number.parseInt(a.timestamp, 10));

      res.json({ controllers });
    } catch (error) {
      console.error('Error listing controllers:', error);
      res.status(500).json({ error: 'Failed to list controllers', controllers: [] });
    }
  }

  // GET /api/replay/logs - API endpoint to list available log files for a controller-timestamp combo
  static getReplayLogs(req: Request, res: Response): void {
    const controllerId = req.query.controllerId as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;
    const serviceTimestamp = req.query.serviceTimestamp as string | undefined;

    if (!controllerId || !timestamp || !serviceTimestamp) {
      res.status(400).json({ error: 'Missing parameters' });
      return;
    }

    try {
      const recordId = `${controllerId}_${timestamp}_${serviceTimestamp}`;
      // New directory structure: records/trade-manager/trade-controllers/trade-controller-X_Y_Z
      const logDir = path.join(process.cwd(), 'records', 'trade-manager', 'trade-controllers', recordId);

      if (!fs.existsSync(logDir)) {
        res.status(404).json({ error: 'Record directory not found', logs: [] });
        return;
      }

      const files = fs.readdirSync(logDir);
      const logFiles: Array<{ name: string; displayName: string; timestamp: number }> = [];

      // Find all replay logs
      const replayLogs = files
        .filter(f => f.startsWith('log-replay-') && f.endsWith('.log'))
        .sort((a, b) => b.localeCompare(a)); // Newest first (descending order)

      for (const replayLog of replayLogs) {
        const regex = /log-replay-(\d+)\.log/;
        const timestampMatch = regex.exec(replayLog);
        const replayTimestamp = timestampMatch ? Number.parseInt(timestampMatch[1]!, 10) : 0;
        const date = new Date(replayTimestamp);
        logFiles.push({
          name: replayLog,
          displayName: `Replay - ${date.toLocaleString()}`,
          timestamp: replayTimestamp,
        });
      }

      // Add original log.log if it exists
      if (files.includes('log.log')) {
        logFiles.push({
          name: 'log.log',
          displayName: 'Original Capture (log.log)',
          timestamp: Number.parseInt(timestamp, 10),
        });
      }

      // Return logs with the default (most recent replay or log.log) marked
      const defaultLog = logFiles.length > 0 ? logFiles[0]!.name : null;

      res.json({
        logs: logFiles,
        defaultLog,
      });
    } catch (error) {
      console.error('Error listing replay logs:', error);
      res.status(500).json({ error: 'Failed to list log files', logs: [] });
    }
  }

  // GET /api/replay/data - API endpoint to fetch chart data for replay
  static async getReplayData(req: Request, res: Response): Promise<void> {
    const controllerId = req.query.controllerId as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;
    const serviceTimestamp = req.query.serviceTimestamp as string | undefined;
    const logFile = req.query.logFile as string | undefined; // Optional: specific log file to load

    if (!controllerId || !timestamp || !serviceTimestamp) {
      res.status(400).json({ error: 'Missing parameters' });
      return;
    }

    try {
      // New directory structure: records/trade-manager/trade-controllers/trade-controller-X_Y_Z
      const recordId = `${controllerId}_${timestamp}_${serviceTimestamp}`;
      const logDir = path.join(process.cwd(), 'records', 'trade-manager', 'trade-controllers', recordId);

      let logFilePath: string | null = null;

      if (logFile) {
        // If a specific log file is requested, use that
        const requestedPath = path.join(logDir, logFile);
        if (fs.existsSync(requestedPath)) {
          logFilePath = requestedPath;
        }
      } else if (fs.existsSync(logDir)) {
        // Find the most recent replay log, or fall back to log.log
        const files = fs.readdirSync(logDir);
        const replayLogs = files
          .filter(f => f.startsWith('log-replay-') && f.endsWith('.log'))
          .sort((a, b) => b.localeCompare(a));

        if (replayLogs.length > 0) {
          logFilePath = path.join(logDir, replayLogs[0]!);
        } else if (files.includes('log.log')) {
          logFilePath = path.join(logDir, 'log.log');
        }
      }

      if (!logFilePath || !fs.existsSync(logFilePath)) {
        res.status(404).json({
          error: `Log file not found for ${recordId}`,
          searchedPath: logDir,
          requestedFile: logFile,
        });
        return;
      }

      // Load and transform the data
      const chartData = await loadChartDataFromLog(logFilePath);

      res.json(chartData);
    } catch (error) {
      console.error('Error loading chart data:', error);
      res.status(500).json({
        error: 'Failed to load chart data',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}