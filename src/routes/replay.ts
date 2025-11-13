import { Router } from 'express';
import { ReplayController } from '../controllers/replayController.js';

const router = Router();

// GET /replay - Serve the replay HTML page
router.get('/replay', ReplayController.getReplayPage);

// GET /api/replay/controllers - API endpoint to list all available controller-timestamp combos
router.get('/api/replay/controllers', ReplayController.getReplayControllers);

// GET /api/replay/logs - API endpoint to list available log files for a controller-timestamp combo
router.get('/api/replay/logs', ReplayController.getReplayLogs);

// GET /api/replay/data - API endpoint to fetch chart data for replay
router.get('/api/replay/data', ReplayController.getReplayData);

export default router;