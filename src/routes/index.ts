import { Router } from 'express';
import controllerRoutes from './controllers.js';
import liveRoutes from './live.js';
import replayRoutes from './replay.js';

const router = Router();

// Mount all route modules
router.use('/', controllerRoutes);
router.use('/', liveRoutes);
router.use('/', replayRoutes);

export default router;