import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { loadChartDataFromLog } from './services/chartDataService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Welcome to the Visualization App');
});

app.get('/live', (req, res) => {
  // Serve the live HTML page for real-time visualization
  res.sendFile(path.join(__dirname, 'public', 'live.html'));
});

// API endpoint to fetch historical data for live view
app.get('/api/live-history', async (req, res) => {
  try {
    // Find the most recent log file
    const recordsDir = path.join(process.cwd(), 'records');
    
    if (!fs.existsSync(recordsDir)) {
      return res.json({ data: [] });
    }

    const recordDirs = fs.readdirSync(recordsDir)
      .filter(f => f.startsWith('trade-controller-'))
      .sort((a, b) => b.localeCompare(a)); // Most recent first

    if (recordDirs.length === 0) {
      return res.json({ data: [] });
    }

    const mostRecentDir = path.join(recordsDir, recordDirs[0]!);
    
    // Find the most recent replay log, or fall back to log.log
    let logFilePath: string | null = null;
    
    if (fs.existsSync(mostRecentDir)) {
      const files = fs.readdirSync(mostRecentDir);
      const replayLogs = files
        .filter(f => f.startsWith('log-replay-') && f.endsWith('.log'))
        .sort((a, b) => b.localeCompare(a));
      
      if (replayLogs.length > 0) {
        logFilePath = path.join(mostRecentDir, replayLogs[0]!);
      } else if (files.includes('log.log')) {
        logFilePath = path.join(mostRecentDir, 'log.log');
      }
    }

    if (!logFilePath || !fs.existsSync(logFilePath)) {
      return res.json({ data: [] });
    }

    // Load chart data from the log file
    const chartData = await loadChartDataFromLog(logFilePath);
    
    // Get the last 1000 ticks
    const maxTicks = 1000;
    const startIndex = Math.max(0, chartData.sentimentScore.length - maxTicks);
    
    const historicalData = {
      sentimentScore: chartData.sentimentScore.slice(startIndex),
      fusionConfidence: chartData.fusionConfidence.slice(startIndex),
      slopeConfidence: chartData.slopeConfidence.slice(startIndex),
      momentumConfidence: chartData.momentumConfidence.slice(startIndex),
      movingAverageConfidence: chartData.movingAverageConfidence.slice(startIndex)
    };

    res.json({ data: historicalData });
  } catch (error) {
    console.error('Error loading live history:', error);
    res.status(500).json({ error: 'Failed to load historical data' });
  }
});

app.get('/replay', (req, res) => {
  const controllerId = req.query.controllerId as string | undefined;
  const timestamp = req.query.timestamp as string | undefined;

  if (!controllerId || !timestamp) {
    return res.status(400).send('Missing parameters. Use ?controllerId=trade-controller-1&timestamp=1761756068332');
  }

  // Serve the replay HTML page
  res.sendFile(path.join(__dirname, 'public', 'replay.html'));
});

// API endpoint to list available log files for a controller-timestamp combo
app.get('/api/replay-logs', (req, res) => {
  const controllerId = req.query.controllerId as string | undefined;
  const timestamp = req.query.timestamp as string | undefined;

  if (!controllerId || !timestamp) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const recordId = `${controllerId}_${timestamp}`;
    const logDir = path.join(process.cwd(), 'records', recordId);

    if (!fs.existsSync(logDir)) {
      return res.status(404).json({ error: 'Record directory not found', logs: [] });
    }

    const files = fs.readdirSync(logDir);
    const logFiles: Array<{ name: string; displayName: string; timestamp: number }> = [];

    // Find all replay logs
    const replayLogs = files
      .filter(f => f.startsWith('log-replay-') && f.endsWith('.log'))
      .sort((a, b) => a.localeCompare(b)); // Oldest first (ascending order)

    for (const replayLog of replayLogs) {
      const timestampMatch = replayLog.match(/log-replay-(\d+)\.log/);
      const replayTimestamp = timestampMatch ? parseInt(timestampMatch[1]!, 10) : 0;
      const date = new Date(replayTimestamp);
      logFiles.push({
        name: replayLog,
        displayName: `Replay - ${date.toLocaleString()}`,
        timestamp: replayTimestamp
      });
    }

    // Add original log.log if it exists
    if (files.includes('log.log')) {
      logFiles.push({
        name: 'log.log',
        displayName: 'Original Capture (log.log)',
        timestamp: parseInt(timestamp, 10)
      });
    }

    // Return logs with the default (most recent replay or log.log) marked
    const defaultLog = logFiles.length > 0 ? logFiles[0]!.name : null;

    res.json({
      logs: logFiles,
      defaultLog
    });
  } catch (error) {
    console.error('Error listing replay logs:', error);
    res.status(500).json({ error: 'Failed to list log files', logs: [] });
  }
});

// API endpoint to fetch chart data for replay
app.get('/api/replay-data', async (req, res) => {
  const controllerId = req.query.controllerId as string | undefined;
  const timestamp = req.query.timestamp as string | undefined;
  const logFile = req.query.logFile as string | undefined; // Optional: specific log file to load

  if (!controllerId || !timestamp) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    // Construct log file path: records/trade-controller-1_1761756068332/
    const recordId = `${controllerId}_${timestamp}`;
    const logDir = path.join(process.cwd(), 'records', recordId);
    
    let logFilePath: string | null = null;
    
    if (logFile) {
      // If a specific log file is requested, use that
      const requestedPath = path.join(logDir, logFile);
      if (fs.existsSync(requestedPath)) {
        logFilePath = requestedPath;
      }
    } else {
      // Find the most recent replay log, or fall back to log.log
      if (fs.existsSync(logDir)) {
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
    }

    if (!logFilePath || !fs.existsSync(logFilePath)) {
      return res.status(404).json({ 
        error: `Log file not found for ${recordId}`,
        searchedPath: logDir,
        requestedFile: logFile
      });
    }

    // Load and transform the data
    const chartData = await loadChartDataFromLog(logFilePath);

    res.json(chartData);
  } catch (error) {
    console.error('Error loading chart data:', error);
    res.status(500).json({ 
      error: 'Failed to load chart data',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

export default app;
