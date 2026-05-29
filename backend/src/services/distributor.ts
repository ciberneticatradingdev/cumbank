import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import { getConnection, sendTransactionWithRetry } from '../utils/solana';
import { HolderInfo } from './snapshot';
import { parseTokenAmountToRaw, formatTokenAmount } from './swapper';

// Rent-exempt minimum for a 0-byte account (system account)
const RENT_EXEMPT_MINIMUM = BigInt(890_880); // ~0.00089 SOL

export interface DistributionResult {
  distributionId: number;
  totalDistributed: string;
  successCount: number;
  failCount: number;
  status: string;
}

interface PaymentInfo {
  wallet: string;
  amountSol: string;
  amountRaw: bigint;
  tokenBalance: string;
  percentage: string;
}

async function logEvent(type: string, message: string, data?: Record<string, unknown>): Promise<void> {
  await pool.query(
    'INSERT INTO events (type, message, data) VALUES ($1, $2, $3)',
    [type, message, data ? JSON.stringify(data) : null]
  );
}

export async function distributeSol(
  claimRoundId: number,
  snapshotId: number,
  holders: HolderInfo[],
  totalAmountSol: string,
  totalSupply: string
): Promise<DistributionResult> {
  logger.info('Starting SOL distribution', {
    claimRoundId,
    snapshotId,
    holderCount: holders.length,
    totalAmountSol,
  });

  // Create distribution record (total_amount_usdc column stores SOL values — schema unchanged)
  const distResult = await pool.query<{ id: number }>(
    `INSERT INTO distributions (claim_round_id, snapshot_id, total_amount_usdc, holder_count, status)
     VALUES ($1, $2, $3, $4, 'distributing') RETURNING id`,
    [claimRoundId, snapshotId, totalAmountSol, holders.length]
  );
  const distributionId = distResult.rows[0].id;

  await logEvent('distribution_started', `Distribution #${distributionId} started`, {
    distributionId,
    claimRoundId,
    totalAmountSol,
    holderCount: holders.length,
  });

  // Calculate each holder's share
  const totalAmountRaw = parseSolToRaw(totalAmountSol);
  const totalSupplyNum = parseFloat(totalSupply);
  const dustThreshold = BigInt(1); // 1 lamport minimum

  const payments: PaymentInfo[] = [];

  for (const holder of holders) {
    const holderBalance = parseFloat(holder.tokenBalance);
    const share = holderBalance / totalSupplyNum;
    const amountRaw = BigInt(Math.floor(Number(totalAmountRaw) * share));

    if (amountRaw < dustThreshold) continue;

    const amountSol = formatSolAmount(amountRaw);

    payments.push({
      wallet: holder.wallet,
      amountSol,
      amountRaw,
      tokenBalance: holder.tokenBalance,
      percentage: holder.percentage,
    });
  }

  logger.info(`Preparing ${payments.length} payments`);

  // Insert all payment records (amount_usdc column stores SOL values — schema unchanged)
  for (const payment of payments) {
    await pool.query(
      `INSERT INTO distribution_payments
       (distribution_id, wallet, amount_usdc, token_balance, percentage, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [distributionId, payment.wallet, payment.amountSol, payment.tokenBalance, payment.percentage]
    );
  }

  // Batch and send payments
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  const batches = chunkArray(payments, config.batchSize);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    logger.info(`Processing batch ${batchIdx + 1}/${batches.length} (${batch.length} payments)`);

    try {
      const connection = getConnection();

      // Check which destination wallets exist on-chain
      const pubkeys = batch.map(p => new PublicKey(p.wallet));
      const accountInfos = await connection.getMultipleAccountsInfo(pubkeys);

      // Filter: skip wallets that don't exist AND would receive less than rent-exempt minimum
      const validPayments: PaymentInfo[] = [];
      const skippedPayments: PaymentInfo[] = [];

      for (let i = 0; i < batch.length; i++) {
        const payment = batch[i];
        const accountExists = accountInfos[i] !== null;

        if (!accountExists && payment.amountRaw < RENT_EXEMPT_MINIMUM) {
          skippedPayments.push(payment);
        } else {
          validPayments.push(payment);
        }
      }

      // Mark skipped payments
      for (const payment of skippedPayments) {
        await pool.query(
          `UPDATE distribution_payments
           SET status = 'skipped', error_message = 'Wallet not initialized on-chain; amount below rent-exempt minimum'
           WHERE distribution_id = $1 AND wallet = $2 AND status = 'pending'`,
          [distributionId, payment.wallet]
        );
        skippedCount++;
      }

      if (validPayments.length === 0) {
        logger.info(`Batch ${batchIdx + 1} skipped entirely (all below rent threshold)`);
        continue;
      }

      // Native SOL transfers — no ATAs needed
      const instructions = validPayments.map((payment) =>
        SystemProgram.transfer({
          fromPubkey: config.walletPublicKey,
          toPubkey: new PublicKey(payment.wallet),
          lamports: payment.amountRaw,
        })
      );

      const result = await sendTransactionWithRetry(instructions, [config.walletKeypair], 3);

      // Mark batch payments as sent
      for (const payment of validPayments) {
        await pool.query(
          `UPDATE distribution_payments
           SET status = 'confirmed', tx_signature = $1, sent_at = NOW()
           WHERE distribution_id = $2 AND wallet = $3 AND status = 'pending'`,
          [result.signature, distributionId, payment.wallet]
        );
        successCount++;
      }

      await logEvent('payment_sent', `Batch ${batchIdx + 1} sent: ${validPayments.length} payments${skippedPayments.length > 0 ? ` (${skippedPayments.length} skipped)` : ''}`, {
        distributionId,
        batchIndex: batchIdx,
        txSignature: result.signature,
        paymentCount: validPayments.length,
        skippedCount: skippedPayments.length,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
      logger.error(`Batch ${batchIdx + 1} failed`, { error: errorMessage, stack: err instanceof Error ? err.stack : undefined });

      // Mark batch payments as failed
      for (const payment of batch) {
        await pool.query(
          `UPDATE distribution_payments
           SET status = 'failed', error_message = $1
           WHERE distribution_id = $2 AND wallet = $3 AND status = 'pending'`,
          [errorMessage, distributionId, payment.wallet]
        );
        failCount++;
      }

      await logEvent('payment_failed', `Batch ${batchIdx + 1} failed: ${errorMessage}`, {
        distributionId,
        batchIndex: batchIdx,
        error: errorMessage,
      });
    }
  }

  // Update distribution status — skipped wallets don't count as failures
  const status = failCount === 0 ? 'completed' : successCount === 0 ? 'failed' : 'partial';

  await pool.query(
    `UPDATE distributions SET status = $1, completed_at = NOW() WHERE id = $2`,
    [status, distributionId]
  );

  const totalDistributed = payments
    .reduce((sum, p) => sum + p.amountRaw, BigInt(0));

  const result: DistributionResult = {
    distributionId,
    totalDistributed: formatSolAmount(totalDistributed),
    successCount,
    failCount,
    status,
  };

  await logEvent('distribution_completed', `Distribution #${distributionId} ${status}`, {
    distributionId,
    totalDistributed: result.totalDistributed,
    successCount: result.successCount,
    failCount: result.failCount,
    status: result.status,
  });

  logger.info('Distribution complete', {
    distributionId: result.distributionId,
    totalDistributed: result.totalDistributed,
    successCount: result.successCount,
    failCount: result.failCount,
    status: result.status,
  });
  return result;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function parseSolToRaw(amount: string): bigint {
  const parts = amount.split('.');
  const whole = BigInt(parts[0]) * BigInt(1_000_000_000);
  const fraction = parts[1] ? BigInt(parts[1].padEnd(9, '0').slice(0, 9)) : BigInt(0);
  return whole + fraction;
}

function formatSolAmount(rawAmount: bigint): string {
  const whole = rawAmount / BigInt(1_000_000_000);
  const fraction = rawAmount % BigInt(1_000_000_000);
  const fractionStr = fraction.toString().padStart(9, '0');
  return `${whole}.${fractionStr}`;
}

// ── SPL Token ($CUM) distribution ────────────────────────────────────────────

// SPL transfers use smaller batches to stay within Solana's transaction size limit
// (each holder needs 2 instructions: createATA + transfer)
const TOKEN_BATCH_SIZE = 5;

interface TokenPaymentInfo {
  wallet: string;
  amountTokens: string;
  amountRaw: bigint;
  tokenBalance: string;
  percentage: string;
}

/**
 * Distribute $CUM tokens to all snapshot holders (instant 50% pool).
 * Records are written to the existing distributions / distribution_payments tables.
 */
export async function distributeCum(
  claimRoundId: number,
  snapshotId: number,
  holders: HolderInfo[],
  totalAmountTokens: string,
  totalSupply: string
): Promise<DistributionResult> {
  logger.info('Starting $CUM distribution (instant)', {
    claimRoundId,
    snapshotId,
    holderCount: holders.length,
    totalAmountTokens,
  });

  const distResult = await pool.query<{ id: number }>(
    `INSERT INTO distributions (claim_round_id, snapshot_id, total_amount_usdc, holder_count, status)
     VALUES ($1, $2, $3, $4, 'distributing') RETURNING id`,
    [claimRoundId, snapshotId, totalAmountTokens, holders.length]
  );
  const distributionId = distResult.rows[0].id;

  await logEvent('distribution_started', `$CUM Distribution #${distributionId} started`, {
    distributionId,
    claimRoundId,
    totalAmountTokens,
    holderCount: holders.length,
  });

  const totalRaw = parseTokenAmountToRaw(totalAmountTokens);
  const totalSupplyNum = parseFloat(totalSupply);
  const payments: TokenPaymentInfo[] = [];

  for (const holder of holders) {
    const share = parseFloat(holder.tokenBalance) / totalSupplyNum;
    const amountRaw = BigInt(Math.floor(Number(totalRaw) * share));
    if (amountRaw < BigInt(1)) continue;

    payments.push({
      wallet: holder.wallet,
      amountTokens: formatTokenAmount(amountRaw),
      amountRaw,
      tokenBalance: holder.tokenBalance,
      percentage: holder.percentage,
    });
  }

  // Insert pending payment records
  for (const p of payments) {
    await pool.query(
      `INSERT INTO distribution_payments
       (distribution_id, wallet, amount_usdc, token_balance, percentage, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [distributionId, p.wallet, p.amountTokens, p.tokenBalance, p.percentage]
    );
  }

  const { successCount, failCount } = await sendTokenBatches(
    payments,
    distributionId,
    config.rewardMint,
    'distribution_payments'
  );

  const status = failCount === 0 ? 'completed' : successCount === 0 ? 'failed' : 'partial';
  await pool.query(
    'UPDATE distributions SET status = $1, completed_at = NOW() WHERE id = $2',
    [status, distributionId]
  );

  const totalDistributed = payments.reduce((s, p) => s + p.amountRaw, BigInt(0));

  const result: DistributionResult = {
    distributionId,
    totalDistributed: formatTokenAmount(totalDistributed),
    successCount,
    failCount,
    status,
  };

  await logEvent('distribution_completed', `$CUM Distribution #${distributionId} ${status}`, { ...result });
  logger.info('$CUM distribution complete', { ...result });
  return result;
}

/**
 * Distribute accumulated $CUM tokens to diamond hands holders only.
 * Records are written to the diamond_distributions / diamond_payments tables.
 * Proportions are calculated relative to diamond holders' total balance (not total supply).
 */
export async function distributeCumDiamond(
  diamondDistributionId: number,
  holders: HolderInfo[],
  totalAmountTokens: string
): Promise<DistributionResult> {
  logger.info('Starting $CUM distribution (diamond hands)', {
    diamondDistributionId,
    holderCount: holders.length,
    totalAmountTokens,
  });

  const totalRaw = parseTokenAmountToRaw(totalAmountTokens);
  // Use diamond holders' combined balance as the denominator
  const diamondTotal = holders.reduce((s, h) => s + parseFloat(h.tokenBalance), 0);
  const payments: TokenPaymentInfo[] = [];

  for (const holder of holders) {
    const share = parseFloat(holder.tokenBalance) / diamondTotal;
    const amountRaw = BigInt(Math.floor(Number(totalRaw) * share));
    if (amountRaw < BigInt(1)) continue;

    payments.push({
      wallet: holder.wallet,
      amountTokens: formatTokenAmount(amountRaw),
      amountRaw,
      tokenBalance: holder.tokenBalance,
      percentage: ((share) * 100).toFixed(6),
    });
  }

  for (const p of payments) {
    await pool.query(
      `INSERT INTO diamond_payments
       (distribution_id, wallet, amount_tokens, token_balance, percentage, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [diamondDistributionId, p.wallet, p.amountTokens, p.tokenBalance, p.percentage]
    );
  }

  const { successCount, failCount } = await sendTokenBatches(
    payments,
    diamondDistributionId,
    config.rewardMint,
    'diamond_payments'
  );

  const status = failCount === 0 ? 'completed' : successCount === 0 ? 'failed' : 'partial';
  await pool.query(
    'UPDATE diamond_distributions SET status = $1, completed_at = NOW() WHERE id = $2',
    [status, diamondDistributionId]
  );

  const totalDistributed = payments.reduce((s, p) => s + p.amountRaw, BigInt(0));

  const result: DistributionResult = {
    distributionId: diamondDistributionId,
    totalDistributed: formatTokenAmount(totalDistributed),
    successCount,
    failCount,
    status,
  };

  await logEvent('diamond_distribution_completed', `Diamond Distribution #${diamondDistributionId} ${status}`, { ...result });
  logger.info('Diamond hands distribution complete', { ...result });
  return result;
}

/**
 * Send $CUM token transfers in small batches.
 * Each batch: createATA (idempotent) + transfer for each holder.
 */
async function sendTokenBatches(
  payments: TokenPaymentInfo[],
  distributionId: number,
  mint: PublicKey,
  paymentsTable: string
): Promise<{ successCount: number; failCount: number }> {
  let successCount = 0;
  let failCount = 0;
  const sourceAta = getAssociatedTokenAddressSync(mint, config.walletPublicKey);
  const batches = chunkArray(payments, TOKEN_BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    logger.info(`Token batch ${batchIdx + 1}/${batches.length} (${batch.length} payments)`);

    try {
      const instructions = [];

      for (const payment of batch) {
        const destAta = getAssociatedTokenAddressSync(mint, new PublicKey(payment.wallet));

        // Create ATA for recipient if it doesn't exist yet
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            config.walletPublicKey,
            destAta,
            new PublicKey(payment.wallet),
            mint
          )
        );

        instructions.push(
          createTransferInstruction(
            sourceAta,
            destAta,
            config.walletPublicKey,
            payment.amountRaw,
            [],
            TOKEN_PROGRAM_ID
          )
        );
      }

      const txResult = await sendTransactionWithRetry(instructions, [config.walletKeypair], 3);

      for (const payment of batch) {
        await pool.query(
          `UPDATE ${paymentsTable}
           SET status = 'confirmed', tx_signature = $1, sent_at = NOW()
           WHERE distribution_id = $2 AND wallet = $3 AND status = 'pending'`,
          [txResult.signature, distributionId, payment.wallet]
        );
        successCount++;
      }

      await logEvent('payment_sent', `Token batch ${batchIdx + 1} sent (${batch.length} payments)`, {
        distributionId,
        batchIndex: batchIdx,
        txSignature: txResult.signature,
        paymentCount: batch.length,
        table: paymentsTable,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Token batch ${batchIdx + 1} failed`, { error: errorMessage });

      for (const payment of batch) {
        await pool.query(
          `UPDATE ${paymentsTable}
           SET status = 'failed', error_message = $1
           WHERE distribution_id = $2 AND wallet = $3 AND status = 'pending'`,
          [errorMessage, distributionId, payment.wallet]
        );
        failCount++;
      }

      await logEvent('payment_failed', `Token batch ${batchIdx + 1} failed: ${errorMessage}`, {
        distributionId,
        batchIndex: batchIdx,
        error: errorMessage,
        table: paymentsTable,
      });
    }
  }

  return { successCount, failCount };
}
