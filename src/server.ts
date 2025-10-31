'use strict';

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import app from './app.js';
import { TradeManagerService } from './services/tradeManager/tradeManagerService.js';
import type { TradeControllerOptions } from './services/tradeManager/core/options.js';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 3000;
const HOST = '0.0.0.0';

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Server started at http://${HOST}:${PORT}`);

  const tradeManagerService = new TradeManagerService();

  const tradeControllerOptions1: TradeControllerOptions = loadPreset('test.json');
  const tradeController1 = tradeManagerService.addTradeController(tradeControllerOptions1);

  tradeController1.on('started', (data) => {
    console.log('Started: ', data);
    io.emit('started', data);
  });

  tradeController1.on('stopped', (data) => {
    console.log('Stopped: ', data);
    io.emit('stopped', data);
  });

  tradeController1.on('tick', (data) => {
    console.log('Tick: ', data);
    
    // Emit chart-friendly tick data to all connected clients
    io.emit('tick', {
      timestamp: data.timestamp,
      sentimentScore: data.heatmapAnalyzer.result.sentimentScore,
      fusion: {
        signal: data.tradeSignalFusion.result.tradeSignal,
        confidence: data.tradeSignalFusion.result.confidence
      },
      slope: {
        signal: data.slopeSignAnalyzer.result.tradeSignal,
        confidence: data.slopeSignAnalyzer.result.confidence
      },
      momentum: {
        signal: data.momentumCompositeAnalyzer.result.tradeSignal,
        confidence: data.momentumCompositeAnalyzer.result.confidence
      },
      movingAverage: {
        signal: data.movingAverageAnalyzer.result.tradeSignal,
        confidence: data.movingAverageAnalyzer.result.confidence
      }
    });
  });

  tradeController1.on('error', (err) => {
    console.error('Error: ', err);
    io.emit('error', { message: err.message });
  });

  // Socket.IO connection handling
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });
});

function loadPreset(filename = 'default.json'): TradeControllerOptions {
  const file = path.resolve(process.cwd(), 'config', 'presets', filename);
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

  return JSON.parse(text) as TradeControllerOptions;
}
