import { Router, Request, Response } from 'express';
import { getSchedulerState } from '../services/scheduler';
import { config } from '../config';

const router = Router();
const startTime = Date.now();

router.get('/health', (_req: Request, res: Response) => {
  const scheduler = getSchedulerState();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  res.json({
    status: 'ok',
    uptime: uptimeSeconds,
    scheduler: {
      running: scheduler.running,
      lastCycle: scheduler.lastCycleAt,
      cycleMs: config.cycleMs,
      cycleCount: scheduler.cycleCount,
    },
    token: config.tokenMint.toBase58(),
  });
});

export default router;
