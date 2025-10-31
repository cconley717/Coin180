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
export const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Global tradeManagerService instance for API endpoint access
export const tradeManagerService = new TradeManagerService();

/**
 * Setup event handlers for a TradeController
 * Emits events to room-specific Socket.IO channels
 */
export function setupControllerEventHandlers(controller: ReturnType<typeof tradeManagerService.addTradeController>): void {
  const roomName = `${controller.getIdentifier()}_${controller.getTimestamp()}`;

  controller.on('started', (data) => {
    console.log('Started:', roomName, data);
    io.to(roomName).emit('started', data);
  });

  controller.on('stopped', (data) => {
    console.log('Stopped:', roomName, data);
    io.to(roomName).emit('stopped', data);
  });

  controller.on('tick', (data) => {
    console.log('Tick:', roomName, data.timestamp);
    
    // Emit chart-friendly tick data to room-specific clients
    io.to(roomName).emit('tick', {
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

  controller.on('error', (err) => {
    console.error('Error:', roomName, err);
    io.to(roomName).emit('error', { message: err.message });
  });
}

httpServer.listen(PORT, HOST, async () => {
  console.log(`Server started at http://${HOST}:${PORT}`);

  // Start the shared Puppeteer capture
  await tradeManagerService.startCapture();
  console.log('TradeManagerService capture started');

  // Socket.IO connection handling with room management
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Handle room join requests from clients
    socket.on('join-room', ({ controllerId, timestamp }: { controllerId: string; timestamp: number }) => {
      const roomName = `${controllerId}_${timestamp}`;
      socket.join(roomName);
      console.log(`Client ${socket.id} joined room: ${roomName}`);
      socket.emit('room-joined', { roomName });
    });

    // Handle room leave requests
    socket.on('leave-room', ({ controllerId, timestamp }: { controllerId: string; timestamp: number }) => {
      const roomName = `${controllerId}_${timestamp}`;
      socket.leave(roomName);
      console.log(`Client ${socket.id} left room: ${roomName}`);
    });
    
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });
});

export function loadPreset(filename = 'default.json'): TradeControllerOptions {
  const file = path.resolve(process.cwd(), 'config', 'presets', filename);
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

  return JSON.parse(text) as TradeControllerOptions;
}
