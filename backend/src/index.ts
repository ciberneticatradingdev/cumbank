import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { runMigrations } from './db/migrate';
import { startScheduler } from './services/scheduler';
import healthRouter from './routes/health';
import statsRouter from './routes/stats';
import distributionsRouter from './routes/distributions';
import holdersRouter from './routes/holders';
import eventsRouter from './routes/events';

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api', healthRouter);
app.use('/api', statsRouter);
app.use('/api', distributionsRouter);
app.use('/api', holdersRouter);
app.use('/api', eventsRouter);

async function main(): Promise<void> {
  logger.info('Starting PumpFun Revenue Share backend...');
  logger.info('Configuration loaded', {
    tokenMint: config.tokenMint.toBase58(),
    cycleMs: config.cycleMs,
    minHolding: config.minHolding,
    batchSize: config.batchSize,
    port: config.port,
  });

  // Run database migrations
  await runMigrations();

  // Start HTTP server
  app.listen(config.port, () => {
    logger.info(`HTTP server listening on port ${config.port}`);
  });

  // Start scheduler
  startScheduler();
}

main().catch((err) => {
  const errorMessage = err instanceof Error ? err.message : String(err);
  logger.error('Fatal startup error', { error: errorMessage });
  process.exit(1);
});
