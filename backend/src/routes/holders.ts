import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';

interface HolderRow {
  wallet: string;
  token_balance: string;
  percentage: string;
}

interface EarningsRow {
  wallet: string;
  total_earned: string;
}

const router = Router();

router.get('/holders', async (_req: Request, res: Response) => {
  try {
    // Get latest snapshot
    const snapshotResult = await pool.query<{ id: number; created_at: Date; holder_count: number; total_supply: string }>(
      'SELECT id, created_at, holder_count, total_supply FROM snapshots ORDER BY created_at DESC LIMIT 1'
    );

    if (snapshotResult.rows.length === 0) {
      res.json({
        holders: [],
        snapshot: null,
      });
      return;
    }

    const snapshot = snapshotResult.rows[0];

    // Get holders from latest snapshot
    const holdersResult = await pool.query<HolderRow>(
      'SELECT wallet, token_balance, percentage FROM snapshot_holders WHERE snapshot_id = $1 ORDER BY token_balance DESC',
      [snapshot.id]
    );

    // Get cumulative earnings per wallet
    const earningsResult = await pool.query<EarningsRow>(
      `SELECT wallet, COALESCE(SUM(amount_usdc), 0) as total_earned 
       FROM distribution_payments 
       WHERE status = 'confirmed'
       GROUP BY wallet`
    );

    const earningsMap = new Map<string, string>();
    earningsResult.rows.forEach((row: EarningsRow) => {
      earningsMap.set(row.wallet, row.total_earned);
    });

    res.json({
      holders: holdersResult.rows.map((row: HolderRow) => ({
        wallet: row.wallet,
        tokenBalance: row.token_balance,
        percentage: row.percentage,
        totalEarned: earningsMap.get(row.wallet) ?? '0.000000',
      })),
      snapshot: {
        id: snapshot.id,
        createdAt: snapshot.created_at.toISOString(),
        holderCount: snapshot.holder_count,
        totalSupply: snapshot.total_supply,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to fetch holders', details: errorMessage });
  }
});

export default router;
