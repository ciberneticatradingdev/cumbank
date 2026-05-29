import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import { getConnection } from '../utils/solana';

export interface ClaimResult {
  claimed: boolean;
  amountSol: string;
  txSignature: string;
  claimRoundId: number;
}

// Creator vault PDA — per-creator account that collects SOL (via WSOL) fees
// Seeds: ["creator-vault", creator_pubkey]
const [CREATOR_VAULT] = PublicKey.findProgramAddressSync(
  [Buffer.from('creator-vault'), config.walletPublicKey.toBuffer()],
  config.pumpswapProgram
);

// CollectCreatorFeeV2 discriminator
const COLLECT_CREATOR_FEE_V2_DISC = Buffer.from('cf118af204221338', 'hex');

// Event authority PDA
const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  config.pumpswapProgram
);

async function logEvent(type: string, message: string, data?: Record<string, unknown>): Promise<void> {
  await pool.query(
    'INSERT INTO events (type, message, data) VALUES ($1, $2, $3)',
    [type, message, data ? JSON.stringify(data) : null]
  );
}

function buildCollectCreatorFeeSOL(): TransactionInstruction {
  const creatorWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);
  const creatorVaultWsolAta = getAssociatedTokenAddressSync(config.wsolMint, CREATOR_VAULT, true);

  return new TransactionInstruction({
    programId: config.pumpswapProgram,
    keys: [
      { pubkey: config.walletPublicKey, isSigner: true, isWritable: true },          // [0] creator
      { pubkey: creatorWsolAta, isSigner: false, isWritable: true },                 // [1] creator WSOL ATA
      { pubkey: CREATOR_VAULT, isSigner: false, isWritable: true },                  // [2] creator vault PDA
      { pubkey: creatorVaultWsolAta, isSigner: false, isWritable: true },            // [3] creator vault WSOL ATA
      { pubkey: config.wsolMint, isSigner: false, isWritable: false },               // [4] WSOL mint
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },              // [5] Token Program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },   // [6] Associated Token Program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },       // [7] System Program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },               // [8] Event Authority PDA
      { pubkey: config.pumpswapProgram, isSigner: false, isWritable: false },        // [9] PumpSwap Program
    ],
    data: COLLECT_CREATOR_FEE_V2_DISC,
  });
}

export async function claimCreatorFees(): Promise<ClaimResult | null> {
  const connection = getConnection();

  await logEvent('claim_started', 'Starting fee claim cycle');
  logger.info('Starting fee claim...');

  try {
    const creatorWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);

    // Get native SOL balance BEFORE claim
    const balanceBefore = BigInt(await connection.getBalance(config.walletPublicKey, 'confirmed'));
    logger.info('SOL balance before claim', { balance: balanceBefore.toString() });

    // [1] Create WSOL ATA if needed (idempotent)
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      config.walletPublicKey,
      creatorWsolAta,
      config.walletPublicKey,
      config.wsolMint
    );

    // [2] Collect SOL fees into WSOL ATA
    const collectIx = buildCollectCreatorFeeSOL();

    // [3] Close WSOL ATA — unwraps WSOL back to native SOL in creator wallet
    const closeAtaIx = createCloseAccountInstruction(
      creatorWsolAta,           // account to close
      config.walletPublicKey,   // destination for native SOL
      config.walletPublicKey    // authority
    );

    // Build versioned transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: config.walletPublicKey,
      recentBlockhash: blockhash,
      instructions: [createAtaIx, collectIx, closeAtaIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([config.walletKeypair]);

    // Simulate first to check for "No creator fee to collect"
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = sim.value.logs || [];
      const noFeeLog = logs.some((l: string) => l.includes('No creator fee to collect'));
      if (noFeeLog) {
        logger.info('No creator fees to collect');
        await logEvent('claim_completed', 'No fees available to claim', { reason: 'no_fees' });
        return null;
      }
      throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    }

    // Check simulation logs for "No creator fee to collect" even without error
    const noFee = sim.value.logs?.some((l: string) => l.includes('No creator fee to collect'));
    if (noFee) {
      logger.info('No creator fees to collect (from sim logs)');
      await logEvent('claim_completed', 'No fees available to claim', { reason: 'no_fees_in_logs' });
      return null;
    }

    // Send for real
    const txSignature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 3,
    });
    logger.info('Claim transaction sent', { signature: txSignature });

    // Confirm
    await connection.confirmTransaction({
      signature: txSignature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    logger.info('Claim transaction confirmed', { signature: txSignature });

    // Get native SOL balance AFTER claim
    // Small delay to ensure balance is updated
    await new Promise(resolve => setTimeout(resolve, 2000));
    const balanceAfter = BigInt(await connection.getBalance(config.walletPublicKey, 'confirmed'));
    logger.info('SOL balance after claim', { balance: balanceAfter.toString() });

    // Calculate delta in lamports (SOL has 9 decimals)
    // Note: delta is net of tx fee; WSOL rent is returned by CloseAccount so it cancels out
    const deltaRaw = balanceAfter - balanceBefore;
    if (deltaRaw <= BigInt(0)) {
      logger.info('No fees to claim (delta = 0)');
      await logEvent('claim_completed', 'No fees available to claim', {
        txSignature,
        delta: '0',
      });
      return null;
    }

    // Convert raw lamports to human-readable (9 decimals)
    const amountSol = formatSolAmount(deltaRaw);
    logger.info('Fees claimed successfully', { amountSol, txSignature });

    // Record in database (amount_usdc column stores SOL values — schema unchanged)
    const insertResult = await pool.query<{ id: number }>(
      `INSERT INTO claim_rounds (tx_signature, amount_usdc, fee_account, status)
       VALUES ($1, $2, $3, 'completed') RETURNING id`,
      [txSignature, amountSol, CREATOR_VAULT.toBase58()]
    );

    const claimRoundId = insertResult.rows[0].id;

    await logEvent('claim_completed', `Claimed ${amountSol} SOL`, {
      txSignature,
      amountSol,
      claimRoundId,
    });

    return {
      claimed: true,
      amountSol,
      txSignature,
      claimRoundId,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Fee claim failed', { error: errorMessage });
    await logEvent('claim_failed', `Fee claim failed: ${errorMessage}`, {
      error: errorMessage,
    });
    return null;
  }
}

function formatSolAmount(rawAmount: bigint): string {
  const whole = rawAmount / BigInt(1_000_000_000);
  const fraction = rawAmount % BigInt(1_000_000_000);
  const fractionStr = fraction.toString().padStart(9, '0');
  return `${whole}.${fractionStr}`;
}
