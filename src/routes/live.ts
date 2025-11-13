import { Router } from 'express';
import { LiveController } from '../controllers/liveController.js';

const router = Router();

// GET /live - Serve the live HTML page for real-time visualization
router.get('/live', LiveController.getLivePage);

// GET /api/live/history - API endpoint to fetch historical data for live view
router.get('/api/live/history', LiveController.getLiveHistory);

// GET /api/live/heatmap - Serve the most recent heatmap for a controller
router.get('/api/live/heatmap', LiveController.getLiveHeatmap);

export default router;