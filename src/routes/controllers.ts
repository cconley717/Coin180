import { Router } from 'express';
import { ControllerController } from '../controllers/controllerController.js';

const router = Router();

// GET /api/presets - List available config presets
router.get('/api/presets', ControllerController.getPresets);

// GET /api/controllers - List all controllers with status
router.get('/api/controllers', ControllerController.getControllers);

// POST /api/controllers - Create new controller with preset
router.post('/api/controllers', ControllerController.createController);

// POST /api/controllers/:id/stop - Stop and remove controller
router.post('/api/controllers/:id/stop', ControllerController.stopController);

export default router;