import { config } from '../config';
import { logger } from '../utils/logger';
import { sleep } from '../utils/solana';
import { pool } from '../db/pool';
import { claimCreatorFees } from './claimer';
import { takeSnapshot } from './snapshot';
import { distributeCum, distributeCumDiamond } from './distributor';
import { swapSolForCum, parseTokenAmountToRaw, formatTokenAmount } from './swapper';
import { updateHolderTracking, getDiamondHandsHolders } from './diamond-tracker';

const DIAMOND_HANDS_INTERVAL_MS = config.diamondHandsMs;

interface SchedulerState {
  running: boolean;
  lastCycleAt: string | null;
  cycleCount: number;
  lastDiamondDistributionAt: string | null;
}

const state: SchedulerState = {
  running: false,
  lastCycleAt: null,
  cycleCount: 0,
  lastDiamondDistributionAt: null,
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
  logger.info('Scheduler started', { cycleMs: config.cycleMs, diamondHandsMs: DIAMOND_HANDS_INTERVAL_MS });
  runLoop();
}

async function runLoop(): Promise<void> {
  while (state.running) {
    state.cycleCount++;
    state.lastCycleAt = new Date().toISOString();
    logger.info(`=== Cycle #${state.cycleCount} started ===`);

    try {
      await runRegularCycle();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Cycle #${state.cycleCount} failed`, { error: errorMessage });
    }

    // Check if it's time for the hourly diamond hands distribution
    try {
      const now = Date.now();
      const lastDiamond = state.lastDiamondDistributionAt
        ? new Date(state.lastDiamondDistributionAt).getTime()
        : 0;

      if (now - lastDiamond >= DIAMOND_HANDS_INTERVAL_MS) {
        state.lastDiamondDistributionAt = new Date().toISOString();
        await runDiamondHandsDistribution();
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Diamond hands distribution cycle failed', { error: errorMessage });
    }

    logger.info(`=== Cycle #${state.cycleCount} ended, waiting ${config.cycleMs}ms ===`);
    await sleep(config.cycleMs);
  }
}

async function runRegularCycle(): Promise<void> {
  // Step 1: Claim creator fees (SOL)
  const claimResult = await claimCreatorFees();

  if (!claimResult || parseFloat(claimResult.amountSol) < config.minClaimSol) {
    logger.info('Nothing to distribute (below threshold or no claim)');
    return;
  }

  // Step 2: Swap all claimed SOL → $CUM
  const swapResult = await swapSolForCum(claimResult.amountSol);

  if (!swapResult) {
    logger.error('Swap failed — skipping distribution for this cycle');
    return;
  }

  // Step 3: Take snapshot of current holders
  const snapshot = await takeSnapshot();

  if (snapshot.holderCount === 0) {
    logger.info('No qualified holders found, skipping distribution');
    return;
  }

  // Step 4: Update diamond hands tracking before distributing
  await updateHolderTracking(snapshot.holders);

  // Step 5: Split swapped $CUM 50 / 50
  const totalRaw = parseTokenAmountToRaw(swapResult.amountTokens);
  const halfRaw = totalRaw / BigInt(2);
  const halfTokens = formatTokenAmount(halfRaw);

  // Step 6: Distribute 50% to ALL qualified holders immediately
  const distResult = await distributeCum(
    claimResult.claimRoundId,
    snapshot.snapshotId,
    snapshot.holders,
    halfTokens,
    snapshot.totalSupply
  );

  // Step 7: Accumulate remaining 50% in DB for the next diamond hands round
  await accumulateForDiamondHands(halfTokens);

  logger.info(`Cycle #${state.cycleCount} complete`, {
    claimedSol: claimResult.amountSol,
    swappedTokens: swapResult.amountTokens,
    distributedNow: halfTokens,
    accumulatedForDiamonds: halfTokens,
    holders: distResult.successCount,
    failed: distResult.failCount,
  });
}

async function accumulateForDiamondHands(amountTokens: string): Promise<void> {
  await pool.query(
    'INSERT INTO accumulated_pool (amount_tokens, pending, created_at) VALUES ($1, true, NOW())',
    [amountTokens]
  );
  logger.info('Accumulated for diamond hands pool', { amountTokens });
}

async function runDiamondHandsDistribution(): Promise<void> {
  logger.info('=== Diamond hands distribution starting ===');

  // Fetch total pending accumulated tokens
  const totalResult = await pool.query<{ total: string }>(
    "SELECT COALESCE(SUM(amount_tokens), '0') as total FROM accumulated_pool WHERE pending = true"
  );
  const totalAccumulated = totalResult.rows[0].total;

  if (parseFloat(totalAccumulated) <= 0) {
    logger.info('No accumulated tokens for diamond hands distribution');
    return;
  }

  // Take a fresh snapshot
  const snapshot = await takeSnapshot();

  if (snapshot.holderCount === 0) {
    logger.info('No holders found, skipping diamond hands distribution');
    return;
  }

  // Filter to diamond hands only
  const diamondHolders = await getDiamondHandsHolders(snapshot.holders);

  if (diamondHolders.length === 0) {
    logger.info('No diamond hands holders qualify yet, leaving tokens accumulated');
    return;
  }

  logger.info('Distributing to diamond hands holders', {
    totalAccumulated,
    diamondHolderCount: diamondHolders.length,
  });

  // Create diamond distribution record
  const distResult = await pool.query<{ id: number }>(
    `INSERT INTO diamond_distributions (snapshot_id, total_amount_tokens, holder_count, status)
     VALUES ($1, $2, $3, 'distributing') RETURNING id`,
    [snapshot.snapshotId, totalAccumulated, diamondHolders.length]
  );
  const diamondDistributionId = distResult.rows[0].id;

  // Send the tokens
  await distributeCumDiamond(diamondDistributionId, diamondHolders, totalAccumulated);

  // Mark all pending accumulated rows as distributed
  await pool.query('UPDATE accumulated_pool SET pending = false WHERE pending = true');

  logger.info('=== Diamond hands distribution complete ===', {
    totalAccumulated,
    diamondHolderCount: diamondHolders.length,
  });
}
