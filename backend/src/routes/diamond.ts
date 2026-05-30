import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { config } from '../config';

const router: Router = Router();

router.get('/diamond', async (_req: Request, res: Response) => {
  try {
    const [
      accumulatedResult,
      totalDistributedResult,
      totalRoundsResult,
      lastDistResult,
      qualifiedResult,
      totalHoldersResult,
      recentResult,
    ] = await Promise.all([
      // Pending accumulated pool
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_tokens::numeric), 0) as total FROM accumulated_pool WHERE pending = true`
      ),
      // Total ever distributed via diamond hands
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(total_amount_tokens::numeric), 0) as total FROM diamond_distributions WHERE status IN ('completed', 'partial')`
      ),
      // Total diamond distribution rounds
      pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM diamond_distributions`
      ),
      // Last diamond distribution timestamp
      pool.query<{ completed_at: Date }>(
        `SELECT completed_at FROM diamond_distributions WHERE status IN ('completed', 'partial') ORDER BY completed_at DESC LIMIT 1`
      ),
      // Qualified diamond hands holders (held 1h+ without selling)
      pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM holder_tracking WHERE COALESCE(balance_decreased_at, first_seen) <= NOW() - INTERVAL '1 hour'`
      ),
      // Total holders in tracking
      pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM holder_tracking`
      ),
      // Recent diamond distributions (last 5)
      pool.query<{
        id: number;
        total_amount_tokens: string;
        holder_count: number;
        status: string;
        created_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT id, total_amount_tokens, holder_count, status, created_at, completed_at FROM diamond_distributions ORDER BY created_at DESC LIMIT 5`
      ),
    ]);

    const accumulated = parseFloat(accumulatedResult.rows[0].total).toFixed(6);
    const totalDistributed = parseFloat(totalDistributedResult.rows[0].total).toFixed(6);
    const totalRounds = parseInt(totalRoundsResult.rows[0].count, 10);
    const lastDistributionAt = lastDistResult.rows[0]?.completed_at?.toISOString() ?? null;
    const qualifiedHolders = parseInt(qualifiedResult.rows[0].count, 10);
    const totalHolders = parseInt(totalHoldersResult.rows[0].count, 10);

    // Calculate ms until next distribution
    let nextDistributionIn = config.diamondHandsMs;
    if (lastDistributionAt) {
      const elapsed = Date.now() - new Date(lastDistributionAt).getTime();
      nextDistributionIn = Math.max(0, config.diamondHandsMs - elapsed);
    }

    const recentDistributions = recentResult.rows.map((r) => ({
      id: r.id,
      totalAmountTokens: parseFloat(r.total_amount_tokens).toFixed(6),
      holderCount: r.holder_count,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
    }));

    res.json({
      accumulated,
      totalDistributed,
      totalRounds,
      lastDistributionAt,
      nextDistributionIn,
      qualifiedHolders,
      totalHolders,
      recentDistributions,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to fetch diamond stats', details: errorMessage });
  }
});

export default router;
