import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { loadChartDataFromLog } from './services/chartDataService.js';
import { tradeManagerService, loadPreset, setupControllerEventHandlers } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Parse JSON request bodies
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== Controller Management API Endpoints =====

// GET /api/presets - List available config presets
app.get('/api/presets', (req, res) => {
  try {
    const presetsDir = path.join(process.cwd(), 'config', 'presets');
    
    if (!fs.existsSync(presetsDir)) {
      return res.json({ presets: [] });
    }

    const files = fs.readdirSync(presetsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        displayName: f.replace('.json', '')
      }));

    res.json({ presets: files });
  } catch (error) {
    console.error('Error listing presets:', error);
    res.status(500).json({ error: 'Failed to list presets' });
  }
});

// GET /api/controllers - List all controllers with status
app.get('/api/controllers', (req, res) => {
  try {
    const controllers = tradeManagerService.getAllControllers().map(controller => ({
      id: controller.getIdentifier(),
      timestamp: controller.getTimestamp(),
      serviceTimestamp: controller.getServiceTimestamp(),
      active: controller.isActive(),
      displayName: `${controller.getIdentifier()} - ${new Date(controller.getTimestamp()).toLocaleString()}`
    }));

    res.json({ controllers });
  } catch (error) {
    console.error('Error listing controllers:', error);
    res.status(500).json({ error: 'Failed to list controllers' });
  }
});

// POST /api/controllers - Create new controller with preset
app.post('/api/controllers', async (req, res) => {
  try {
    const { presetFilename } = req.body as { presetFilename?: string };

    if (!presetFilename) {
      return res.status(400).json({ error: 'Missing presetFilename' });
    }

    // Validate preset exists
    const presetPath = path.join(process.cwd(), 'config', 'presets', presetFilename);
    if (!fs.existsSync(presetPath)) {
      return res.status(404).json({ error: 'Preset not found' });
    }

    // Load preset and create controller
    const options = loadPreset(presetFilename);
    const controller = tradeManagerService.addTradeController(options);
    
    // Setup event handlers for WebSocket room emission
    setupControllerEventHandlers(controller);

    // Start the controller automatically
    await tradeManagerService.startController(controller);

    res.json({
      id: controller.getIdentifier(),
      timestamp: controller.getTimestamp(),
      serviceTimestamp: controller.getServiceTimestamp(),
      active: controller.isActive(),
      message: 'Controller created and started successfully'
    });
  } catch (error) {
    console.error('Error creating controller:', error);
    res.status(500).json({ error: 'Failed to create controller' });
  }
});

// POST /api/controllers/:id/stop - Stop and remove controller
app.post('/api/controllers/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;
    const { timestamp, serviceTimestamp } = req.body as { timestamp?: number; serviceTimestamp?: number };

    if (!timestamp || !serviceTimestamp) {
      return res.status(400).json({ error: 'Missing timestamp or serviceTimestamp' });
    }

    const controller = tradeManagerService.getController(id, timestamp, serviceTimestamp);
    if (!controller) {
      return res.status(404).json({ error: 'Controller not found' });
    }

    await tradeManagerService.stopController(controller);
    
    // Remove the controller after stopping since it loses analysis continuity
    tradeManagerService.removeTradeController(controller);

    res.json({ message: 'Controller stopped and removed successfully' });
  } catch (error) {
    console.error('Error stopping controller:', error);
    const message = error instanceof Error ? error.message : 'Failed to stop controller';
    res.status(500).json({ error: message });
  }
});

// ===== End Controller Management API Endpoints =====

app.get('/live', (req, res) => {
  const controllerId = req.query.controllerId as string | undefined;
  const timestamp = req.query.timestamp as string | undefined;

  if (!controllerId || !timestamp) {
    return res.status(400).send('Missing parameters. Use ?controllerId=trade-controller-1&timestamp=1761756068332');
  }

  // Serve the live HTML page for real-time visualization
  res.sendFile(path.join(__dirname, 'public', 'live.html'));
});

// API endpoint to fetch historical data for live view
app.get('/api/live-history', async (req, res) => {
  try {
    const controllerId = req.query.controllerId as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;
    const serviceTimestamp = req.query.serviceTimestamp as string | undefined;

    if (!controllerId || !timestamp || !serviceTimestamp) {
      return res.status(400).json({ error: 'Missing parameters: controllerId, timestamp, and serviceTimestamp required' });
    }

    // New directory structure: records/trade-manager/trade-controllers/trade-controller-X_Y_Z
    const recordId = `${controllerId}_${timestamp}_${serviceTimestamp}`;
    const logDir = path.join(process.cwd(), 'records', 'trade-manager', 'trade-controllers', recordId);
    
    if (!fs.existsSync(logDir)) {
      return res.status(404).json({ error: 'Controller record not found', data: [] });
    }

    // Find the most recent replay log, or fall back to log.log
    let logFilePath: string | null = null;
    
    const files = fs.readdirSync(logDir);
    const replayLogs = files
      .filter(f => f.startsWith('log-replay-') && f.endsWith('.log'))
      .sort((a, b) => b.localeCompare(a));
    
    if (replayLogs.length > 0) {
      logFilePath = path.join(logDir, replayLogs[0]!);
    } else if (files.includes('log.log')) {
      logFilePath = path.join(logDir, 'log.log');
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

// API endpoint to list all available controller-timestamp combos
app.get('/api/replay-controllers', (req, res) => {
  try {
    // New directory structure: records/trade-manager/trade-controllers/
    const controllersDir = path.join(process.cwd(), 'records', 'trade-manager', 'trade-controllers');

    if (!fs.existsSync(controllersDir)) {
      return res.json({ controllers: [] });
    }

    const dirs = fs.readdirSync(controllersDir);
    const controllers: Array<{ id: string; controllerId: string; timestamp: string; serviceTimestamp: string; displayName: string }> = [];

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
          displayName: `${controllerId} - ${date.toLocaleString()}`
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
});

// API endpoint to list available log files for a controller-timestamp combo
app.get('/api/replay-logs', (req, res) => {
  const controllerId = req.query.controllerId as string | undefined;
  const timestamp = req.query.timestamp as string | undefined;
  const serviceTimestamp = req.query.serviceTimestamp as string | undefined;

  if (!controllerId || !timestamp || !serviceTimestamp) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const recordId = `${controllerId}_${timestamp}_${serviceTimestamp}`;
    // New directory structure: records/trade-manager/trade-controllers/trade-controller-X_Y_Z
    const logDir = path.join(process.cwd(), 'records', 'trade-manager', 'trade-controllers', recordId);

    if (!fs.existsSync(logDir)) {
      return res.status(404).json({ error: 'Record directory not found', logs: [] });
    }

    const files = fs.readdirSync(logDir);
    const logFiles: Array<{ name: string; displayName: string; timestamp: number }> = [];

    // Find all replay logs
    const replayLogs = files
      .filter(f => f.startsWith('log-replay-') && f.endsWith('.log'))
      .sort((a, b) => b.localeCompare(a)); // Newest first (descending order)

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
  const serviceTimestamp = req.query.serviceTimestamp as string | undefined;
  const logFile = req.query.logFile as string | undefined; // Optional: specific log file to load

  if (!controllerId || !timestamp || !serviceTimestamp) {
    return res.status(400).json({ error: 'Missing parameters' });
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
