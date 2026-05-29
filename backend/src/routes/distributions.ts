import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';

interface DistributionRow {
  id: number;
  claim_round_id: number;
  snapshot_id: number;
  total_amount_usdc: string;
  holder_count: number;
  status: string;
  created_at: Date;
  completed_at: Date | null;
}

interface PaymentRow {
  id: number;
  wallet: string;
  amount_usdc: string;
  token_balance: string;
  percentage: string;
  tx_signature: string | null;
  status: string;
  error_message: string | null;
  sent_at: Date | null;
}

const router: Router = Router();

router.get('/distributions', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const offset = (page - 1) * limit;

    const [countResult, dataResult] = await Promise.all([
      pool.query<{ count: string }>('SELECT COUNT(*) as count FROM distributions'),
      pool.query<DistributionRow>(
        'SELECT * FROM distributions ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      distributions: dataResult.rows.map((row) => ({
        id: row.id,
        claimRoundId: row.claim_round_id,
        snapshotId: row.snapshot_id,
        totalAmountSol: row.total_amount_usdc,
        holderCount: row.holder_count,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to fetch distributions', details: errorMessage });
  }
});

router.get('/distributions/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params['id']), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid distribution ID' });
      return;
    }

    const [distResult, paymentsResult] = await Promise.all([
      pool.query<DistributionRow>('SELECT * FROM distributions WHERE id = $1', [id]),
      pool.query<PaymentRow>(
        'SELECT * FROM distribution_payments WHERE distribution_id = $1 ORDER BY amount_usdc DESC',
        [id]
      ),
    ]);

    if (distResult.rows.length === 0) {
      res.status(404).json({ error: 'Distribution not found' });
      return;
    }

    const dist = distResult.rows[0];

    res.json({
      distribution: {
        id: dist.id,
        claimRoundId: dist.claim_round_id,
        snapshotId: dist.snapshot_id,
        totalAmountSol: dist.total_amount_usdc,
        holderCount: dist.holder_count,
        status: dist.status,
        createdAt: dist.created_at.toISOString(),
        completedAt: dist.completed_at?.toISOString() ?? null,
      },
      payments: paymentsResult.rows.map((row) => ({
        id: row.id,
        wallet: row.wallet,
        amountSol: row.amount_usdc,
        tokenBalance: row.token_balance,
        percentage: row.percentage,
        txSignature: row.tx_signature,
        status: row.status,
        errorMessage: row.error_message,
        sentAt: row.sent_at?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to fetch distribution', details: errorMessage });
  }
});

export default router;
