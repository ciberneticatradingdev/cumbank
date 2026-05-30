import { Router, Request, Response } from 'express';
import { config } from '../config';
import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import { swapSolForCum, parseTokenAmountToRaw, formatTokenAmount } from '../services/swapper';
import { takeSnapshot } from '../services/snapshot';
import { distributeCum } from '../services/distributor';
import { updateHolderTracking } from '../services/diamond-tracker';

const router: Router = Router();

/**
 * POST /api/admin/manual-distribute
 * 
 * One-time manual distribution: swap SOL → $CUM and distribute 100% to all holders.
 * Body: { "amountSol": "2.5", "secret": "cumbank-admin-2026" }
 * 
 * Everything gets recorded in the DB and shows up on the dashboard.
 */
router.post('/admin/manual-distribute', async (req: Request, res: Response) => {
  const { amountSol, secret } = req.body;

  // Simple auth — not production-grade, just prevents random calls
  if (secret !== 'cumbank-admin-2026') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!amountSol || parseFloat(amountSol) <= 0) {
    res.status(400).json({ error: 'amountSol must be a positive number' });
    return;
  }

  logger.info('=== Manual distribution triggered ===', { amountSol });

  try {
    // Step 1: Swap SOL → $CUM
    logger.info('Step 1: Swapping SOL → $CUM', { amountSol });
    const swapResult = await swapSolForCum(amountSol);

    if (!swapResult) {
      res.status(500).json({ error: 'Swap failed — check logs' });
      return;
    }

    logger.info('Swap completed', {
      amountSol,
      tokensReceived: swapResult.amountTokens,
      txSignature: swapResult.txSignature,
    });

    // Step 2: Record as a claim round (so it shows in the dashboard)
    const claimResult = await pool.query<{ id: number }>(
      `INSERT INTO claim_rounds (tx_signature, amount_usdc, fee_account, status)
       VALUES ($1, $2, 'manual-distribution', 'completed') RETURNING id`,
      [swapResult.txSignature, amountSol]
    );
    const claimRoundId = claimResult.rows[0].id;

    // Step 3: Take snapshot of current holders
    logger.info('Step 2: Taking holder snapshot...');
    const snapshot = await takeSnapshot();

    if (snapshot.holderCount === 0) {
      res.status(500).json({ error: 'No qualified holders found' });
      return;
    }

    logger.info('Snapshot taken', {
      holderCount: snapshot.holderCount,
      totalSupply: snapshot.totalSupply,
    });

    // Step 4: Update diamond hands tracking
    await updateHolderTracking(snapshot.holders);

    // Step 5: Distribute 100% of $CUM to ALL holders (no 50/50 split — special distribution)
    logger.info('Step 3: Distributing 100% of $CUM to holders...', {
      totalTokens: swapResult.amountTokens,
      holders: snapshot.holderCount,
    });

    const distResult = await distributeCum(
      claimRoundId,
      snapshot.snapshotId,
      snapshot.holders,
      swapResult.amountTokens,
      snapshot.totalSupply
    );

    logger.info('=== Manual distribution complete ===', {
      amountSol,
      tokensSwapped: swapResult.amountTokens,
      swapTx: swapResult.txSignature,
      distributionId: distResult.distributionId,
      totalDistributed: distResult.totalDistributed,
      successCount: distResult.successCount,
      failCount: distResult.failCount,
      status: distResult.status,
    });

    // Log as event
    await pool.query(
      'INSERT INTO events (type, message, data) VALUES ($1, $2, $3)',
      [
        'manual_distribution',
        `Manual distribution: ${amountSol} SOL → ${swapResult.amountTokens} $CUM to ${distResult.successCount} holders`,
        JSON.stringify({
          amountSol,
          tokensSwapped: swapResult.amountTokens,
          swapTx: swapResult.txSignature,
          distributionId: distResult.distributionId,
        }),
      ]
    );

    res.json({
      success: true,
      swap: {
        amountSol,
        tokensReceived: swapResult.amountTokens,
        txSignature: swapResult.txSignature,
      },
      distribution: {
        id: distResult.distributionId,
        totalDistributed: distResult.totalDistributed,
        successCount: distResult.successCount,
        failCount: distResult.failCount,
        status: distResult.status,
      },
      snapshot: {
        holderCount: snapshot.holderCount,
        totalSupply: snapshot.totalSupply,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Manual distribution failed', { error: errorMessage, stack: err instanceof Error ? err.stack : undefined });
    res.status(500).json({ error: errorMessage });
  }
});

export default router;
