import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { config } from '../config';

const router = Router();

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [
      totalDistResult,
      totalRoundsResult,
      totalClaimsResult,
      totalClaimedResult,
      holdersResult,
      lastClaimResult,
      lastDistResult,
    ] = await Promise.all([
      pool.query<{ total: string }>(`SELECT COALESCE(SUM(total_amount_usdc), 0) as total FROM distributions WHERE status IN ('completed', 'partial')`),
      pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM distributions`),
      pool.query<{ count: string }>(`SELECT COUNT(*) as count FROM claim_rounds WHERE status = 'completed'`),
      pool.query<{ total: string }>(`SELECT COALESCE(SUM(amount_usdc), 0) as total FROM claim_rounds WHERE status = 'completed'`),
      pool.query<{ holder_count: number }>(`SELECT COALESCE(holder_count, 0) as holder_count FROM snapshots ORDER BY created_at DESC LIMIT 1`),
      pool.query<{ created_at: Date }>(`SELECT created_at FROM claim_rounds ORDER BY created_at DESC LIMIT 1`),
      pool.query<{ created_at: Date }>(`SELECT created_at FROM distributions ORDER BY created_at DESC LIMIT 1`),
    ]);

    const totalDistributed = totalDistResult.rows[0].total;
    const totalRounds = parseInt(totalRoundsResult.rows[0].count, 10);
    const totalClaims = parseInt(totalClaimsResult.rows[0].count, 10);
    const totalClaimedSol = totalClaimedResult.rows[0].total;
    const currentHolders = holdersResult.rows[0]?.holder_count ?? 0;
    const lastClaimAt = lastClaimResult.rows[0]?.created_at?.toISOString() ?? null;
    const lastDistributionAt = lastDistResult.rows[0]?.created_at?.toISOString() ?? null;
    const avgPerRound = totalRounds > 0
      ? (parseFloat(totalDistributed) / totalRounds).toFixed(9)
      : '0.000000000';

    res.json({
      totalDistributed,
      totalRounds,
      totalClaims,
      totalClaimedSol,
      currentHolders,
      qualifiedHolders: currentHolders,
      lastClaimAt,
      lastDistributionAt,
      avgPerRound,
      tokenMint: config.tokenMint.toBase58(),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to fetch stats', details: errorMessage });
  }
});

export default router;
