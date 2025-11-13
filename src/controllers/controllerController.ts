import type { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { tradeManagerService, loadPreset, setupControllerEventHandlers } from '../server.js';

export class ControllerController {
  // GET /api/presets - List available config presets
  static getPresets(req: Request, res: Response): void {
    try {
      const presetsDir = path.join(process.cwd(), 'config', 'presets');

      if (!fs.existsSync(presetsDir)) {
        res.json({ presets: [] });
        return;
      }

      const files = fs
        .readdirSync(presetsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({
          name: f,
          displayName: f.replace('.json', ''),
        }));

      res.json({ presets: files });
    } catch (error) {
      console.error('Error listing presets:', error);
      res.status(500).json({ error: 'Failed to list presets' });
    }
  }

  // GET /api/controllers - List all controllers with status
  static getControllers(req: Request, res: Response): void {
    try {
      const controllers = tradeManagerService.getAllControllers().map(controller => ({
        id: controller.getIdentifier(),
        timestamp: controller.getTimestamp(),
        serviceTimestamp: controller.getServiceTimestamp(),
        active: controller.isActive(),
        displayName: `${controller.getIdentifier()} - ${new Date(controller.getTimestamp()).toLocaleString()}`,
      }));

      res.json({ controllers });
    } catch (error) {
      console.error('Error listing controllers:', error);
      res.status(500).json({ error: 'Failed to list controllers' });
    }
  }

  // POST /api/controllers - Create new controller with preset
  static async createController(req: Request, res: Response): Promise<void> {
    try {
      const { presetFilename } = req.body as { presetFilename?: string };

      if (!presetFilename) {
        res.status(400).json({ error: 'Missing presetFilename' });
        return;
      }

      // Validate preset exists
      const presetPath = path.join(process.cwd(), 'config', 'presets', presetFilename);
      if (!fs.existsSync(presetPath)) {
        res.status(404).json({ error: 'Preset not found' });
        return;
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
        message: 'Controller created and started successfully',
      });
    } catch (error) {
      console.error('Error creating controller:', error);
      res.status(500).json({ error: 'Failed to create controller' });
    }
  }

  // POST /api/controllers/:id/stop - Stop and remove controller
  static async stopController(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { timestamp, serviceTimestamp } = req.body as { timestamp?: number; serviceTimestamp?: number };

      if (!id || !timestamp || !serviceTimestamp) {
        res.status(400).json({ error: 'Missing id, timestamp or serviceTimestamp' });
        return;
      }

      const controller = tradeManagerService.getController(id, timestamp, serviceTimestamp);
      if (!controller) {
        res.status(404).json({ error: 'Controller not found' });
        return;
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
  }
}