import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import { config } from '../config';
import { HolderInfo } from './snapshot';

/**
 * Upsert holder_tracking rows based on the current snapshot.
 * If a holder's balance has decreased since last seen, their hold timer is reset
 * by setting balance_decreased_at = NOW().
 */
export async function updateHolderTracking(holders: HolderInfo[]): Promise<void> {
  if (holders.length === 0) return;

  const now = new Date();

  for (const holder of holders) {
    const currentBalance = parseFloat(holder.tokenBalance);

    const existing = await pool.query<{
      last_balance: string;
    }>(
      'SELECT last_balance FROM holder_tracking WHERE wallet = $1',
      [holder.wallet]
    );

    if (existing.rows.length === 0) {
      // First time we see this holder
      await pool.query(
        `INSERT INTO holder_tracking (wallet, first_seen, last_balance, created_at, updated_at)
         VALUES ($1, $2, $3, $2, $2)`,
        [holder.wallet, now, currentBalance]
      );
    } else {
      const prevBalance = parseFloat(existing.rows[0].last_balance);

      if (currentBalance < prevBalance) {
        // Balance decreased → reset hold timer
        await pool.query(
          `UPDATE holder_tracking
           SET last_balance = $1, balance_decreased_at = $2, updated_at = $2
           WHERE wallet = $3`,
          [currentBalance, now, holder.wallet]
        );
        logger.debug('Hold timer reset', {
          wallet: holder.wallet,
          prev: prevBalance,
          current: currentBalance,
        });
      } else {
        // Balance unchanged or increased — no reset needed
        await pool.query(
          `UPDATE holder_tracking
           SET last_balance = $1, updated_at = $2
           WHERE wallet = $3`,
          [currentBalance, now, holder.wallet]
        );
      }
    }
  }
}

/**
 * Returns the subset of `allHolders` that qualify as diamond hands.
 *
 * A holder qualifies when they have held continuously (without any balance
 * decrease) for at least config.diamondHandsMs milliseconds.
 *
 * Effective hold start = balance_decreased_at if ever decreased, else first_seen.
 * The holder qualifies if that timestamp is <= (NOW - diamondHandsMs).
 */
export async function getDiamondHandsHolders(allHolders: HolderInfo[]): Promise<HolderInfo[]> {
  if (allHolders.length === 0) return [];

  const cutoff = new Date(Date.now() - config.diamondHandsMs);

  const result = await pool.query<{ wallet: string }>(
    `SELECT wallet
     FROM holder_tracking
     WHERE COALESCE(balance_decreased_at, first_seen) <= $1`,
    [cutoff]
  );

  const qualifiedWallets = new Set(result.rows.map(r => r.wallet));

  const diamonds = allHolders.filter(h => qualifiedWallets.has(h.wallet));
  logger.info('Diamond hands holders', {
    total: allHolders.length,
    qualified: diamonds.length,
    cutoffMs: config.diamondHandsMs,
  });
  return diamonds;
}
