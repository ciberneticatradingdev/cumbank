import { config } from '../config';
import { logger } from '../utils/logger';
import { sleep } from '../utils/solana';
import { claimCreatorFees } from './claimer';
import { takeSnapshot } from './snapshot';
import { distributeSol } from './distributor';

interface SchedulerState {
  running: boolean;
  lastCycleAt: string | null;
  cycleCount: number;
}

const state: SchedulerState = {
  running: false,
  lastCycleAt: null,
  cycleCount: 0,
};

export function getSchedulerState(): SchedulerState {
  return { ...state };
}

export function startScheduler(): void {
  if (state.running) {
    logger.warn('Scheduler already running');
    return;
  }

  state.running = true;
  logger.info('Scheduler started', { cycleMs: config.cycleMs });
  runLoop();
}

async function runLoop(): Promise<void> {
  while (state.running) {
    state.cycleCount++;
    state.lastCycleAt = new Date().toISOString();
    logger.info(`=== Cycle #${state.cycleCount} started ===`);

    try {
      // Step 1: Claim fees
      const claimResult = await claimCreatorFees();

      if (!claimResult || parseFloat(claimResult.amountSol) < config.minClaimSol) {
        logger.info('Nothing to distribute (below threshold or no claim)');
      } else {
        // Step 2: Take snapshot
        const snapshot = await takeSnapshot();

        if (snapshot.holderCount === 0) {
          logger.info('No qualified holders found, skipping distribution');
        } else {
          // Step 3: Distribute SOL
          const distResult = await distributeSol(
            claimResult.claimRoundId,
            snapshot.snapshotId,
            snapshot.holders,
            claimResult.amountSol,
            snapshot.totalSupply
          );
          logger.info(`Cycle #${state.cycleCount} complete`, {
            claimed: claimResult.amountSol,
            distributed: distResult.totalDistributed,
            holders: distResult.successCount,
            failed: distResult.failCount,
          });
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Cycle #${state.cycleCount} failed`, { error: errorMessage });
    }

    logger.info(`=== Cycle #${state.cycleCount} ended, waiting ${config.cycleMs}ms ===`);
    await sleep(config.cycleMs);
  }
}
