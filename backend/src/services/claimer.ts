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

// ── PumpAMM (post-bond) — CollectCoinCreatorFee ─────────────────────────────
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// PDA: ["creator_vault", creator] on PumpAMM (underscore)
const [AMM_CREATOR_VAULT] = PublicKey.findProgramAddressSync(
  [Buffer.from('creator_vault'), config.walletPublicKey.toBuffer()],
  PUMP_AMM_PROGRAM
);

// CollectCoinCreatorFee discriminator
const COLLECT_COIN_CREATOR_FEE_DISC = Buffer.from('a039592ab58b2b42', 'hex');

// Event authority PDA on PumpAMM
const [AMM_EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  PUMP_AMM_PROGRAM
);

// ── PumpSwap (pre-bond, legacy) — CollectCreatorFeeV2 ───────────────────────
// PDA: ["creator-vault", creator] on PumpSwap (hyphen)
const [PUMPSWAP_CREATOR_VAULT] = PublicKey.findProgramAddressSync(
  [Buffer.from('creator-vault'), config.walletPublicKey.toBuffer()],
  config.pumpswapProgram
);

const COLLECT_CREATOR_FEE_V2_DISC = Buffer.from('cf118af204221338', 'hex');

const [PUMPSWAP_EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  config.pumpswapProgram
);

// ─────────────────────────────────────────────────────────────────────────────

async function logEvent(type: string, message: string, data?: Record<string, unknown>): Promise<void> {
  await pool.query(
    'INSERT INTO events (type, message, data) VALUES ($1, $2, $3)',
    [type, message, data ? JSON.stringify(data) : null]
  );
}

/**
 * Build CollectCoinCreatorFee instruction for PumpAMM (post-bond).
 * Account layout from verified on-chain tx:
 * 0: quote_mint (WSOL)
 * 1: token_program
 * 2: creator (signer)
 * 3: creator_vault_authority (PDA)
 * 4: creator_vault_ata (WSOL ATA of vault authority)
 * 5: creator_wsol_ata (destination WSOL ATA)
 * 6: event_authority
 * 7: program (self)
 */
function buildCollectCoinCreatorFee(): TransactionInstruction {
  const creatorWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);
  const creatorVaultWsolAta = getAssociatedTokenAddressSync(config.wsolMint, AMM_CREATOR_VAULT, true);

  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    keys: [
      { pubkey: config.wsolMint, isSigner: false, isWritable: false },               // [0] quote_mint (WSOL)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },              // [1] Token Program
      { pubkey: config.walletPublicKey, isSigner: true, isWritable: true },          // [2] creator (signer)
      { pubkey: AMM_CREATOR_VAULT, isSigner: false, isWritable: true },              // [3] creator_vault_authority PDA
      { pubkey: creatorVaultWsolAta, isSigner: false, isWritable: true },            // [4] creator_vault WSOL ATA
      { pubkey: creatorWsolAta, isSigner: false, isWritable: true },                 // [5] creator WSOL ATA (destination)
      { pubkey: AMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },           // [6] event_authority
      { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },              // [7] program (self)
    ],
    data: COLLECT_COIN_CREATOR_FEE_DISC,
  });
}

/**
 * Build CollectCreatorFeeV2 instruction for PumpSwap (pre-bond, legacy).
 */
function buildCollectCreatorFeeV2(): TransactionInstruction {
  const creatorWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);
  const creatorVaultWsolAta = getAssociatedTokenAddressSync(config.wsolMint, PUMPSWAP_CREATOR_VAULT, true);

  return new TransactionInstruction({
    programId: config.pumpswapProgram,
    keys: [
      { pubkey: config.walletPublicKey, isSigner: true, isWritable: true },
      { pubkey: creatorWsolAta, isSigner: false, isWritable: true },
      { pubkey: PUMPSWAP_CREATOR_VAULT, isSigner: false, isWritable: true },
      { pubkey: creatorVaultWsolAta, isSigner: false, isWritable: true },
      { pubkey: config.wsolMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PUMPSWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: config.pumpswapProgram, isSigner: false, isWritable: false },
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

    // [2] Collect fees from BOTH programs (PumpAMM post-bond + PumpSwap pre-bond)
    // Both instructions are safe to call even if no fees exist — they just no-op
    const collectAmmIx = buildCollectCoinCreatorFee();
    const collectLegacyIx = buildCollectCreatorFeeV2();

    // [3] Close WSOL ATA — unwraps WSOL back to native SOL
    const closeAtaIx = createCloseAccountInstruction(
      creatorWsolAta,
      config.walletPublicKey,
      config.walletPublicKey
    );

    // Build versioned transaction with both claim instructions
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: config.walletPublicKey,
      recentBlockhash: blockhash,
      instructions: [createAtaIx, collectAmmIx, collectLegacyIx, closeAtaIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([config.walletKeypair]);

    // Simulate first
    const sim = await connection.simulateTransaction(tx);
    const logs = sim.value.logs || [];

    if (sim.value.err) {
      // If the legacy claim fails but AMM claim succeeds, retry with AMM only
      const hasAmmSuccess = logs.some((l: string) => l.includes('CollectCoinCreatorFee'));
      if (hasAmmSuccess) {
        logger.info('Legacy claim failed but AMM claim available, retrying AMM only');
        return await claimAmmOnly(connection, creatorWsolAta, balanceBefore);
      }

      const noFeeLog = logs.some((l: string) =>
        l.includes('No creator fee to collect') || l.includes('No coin creator fee')
      );
      if (noFeeLog) {
        logger.info('No creator fees to collect');
        await logEvent('claim_completed', 'No fees available to claim', { reason: 'no_fees' });
        return null;
      }
      throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    }

    // Check if both report no fees
    const noFeeAmm = logs.some((l: string) => l.includes('No coin creator fee'));
    const noFeeLegacy = logs.some((l: string) => l.includes('No creator fee to collect'));
    if (noFeeAmm && noFeeLegacy) {
      logger.info('No creator fees in either program');
      await logEvent('claim_completed', 'No fees available', { reason: 'no_fees_both' });
      return null;
    }

    // Send for real
    const txSignature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 3,
    });
    logger.info('Claim transaction sent', { signature: txSignature });

    await connection.confirmTransaction({
      signature: txSignature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    logger.info('Claim transaction confirmed', { signature: txSignature });

    return await recordClaim(connection, balanceBefore, txSignature);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('Fee claim failed (dual), trying AMM-only fallback', { error: errorMessage });

    // Fallback: try AMM-only claim if dual fails
    try {
      return await claimAmmOnly(connection,
        getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey),
        BigInt(await connection.getBalance(config.walletPublicKey, 'confirmed'))
      );
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      logger.error('AMM-only fallback also failed', { error: fallbackMsg });
      await logEvent('claim_failed', `Fee claim failed: ${fallbackMsg}`, { error: fallbackMsg });
      return null;
    }
  }
}

/**
 * Fallback: claim only from PumpAMM (post-bond) if dual claim fails.
 */
async function claimAmmOnly(
  connection: ReturnType<typeof getConnection>,
  creatorWsolAta: PublicKey,
  balanceBefore: bigint
): Promise<ClaimResult | null> {
  logger.info('Attempting AMM-only fee claim...');

  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    config.walletPublicKey,
    creatorWsolAta,
    config.walletPublicKey,
    config.wsolMint
  );

  const collectAmmIx = buildCollectCoinCreatorFee();

  const closeAtaIx = createCloseAccountInstruction(
    creatorWsolAta,
    config.walletPublicKey,
    config.walletPublicKey
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const messageV0 = new TransactionMessage({
    payerKey: config.walletPublicKey,
    recentBlockhash: blockhash,
    instructions: [createAtaIx, collectAmmIx, closeAtaIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([config.walletKeypair]);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    const noFee = sim.value.logs?.some((l: string) =>
      l.includes('No coin creator fee') || l.includes('No creator fee')
    );
    if (noFee) {
      logger.info('No AMM creator fees to collect');
      return null;
    }
    throw new Error(`AMM simulation failed: ${JSON.stringify(sim.value.err)}`);
  }

  const txSignature = await connection.sendTransaction(tx, {
    skipPreflight: true,
    maxRetries: 3,
  });
  logger.info('AMM claim sent', { signature: txSignature });

  await connection.confirmTransaction({
    signature: txSignature,
    blockhash,
    lastValidBlockHeight,
  }, 'confirmed');
  logger.info('AMM claim confirmed', { signature: txSignature });

  return await recordClaim(connection, balanceBefore, txSignature);
}

async function recordClaim(
  connection: ReturnType<typeof getConnection>,
  balanceBefore: bigint,
  txSignature: string
): Promise<ClaimResult | null> {
  await new Promise(resolve => setTimeout(resolve, 2000));
  const balanceAfter = BigInt(await connection.getBalance(config.walletPublicKey, 'confirmed'));
  logger.info('SOL balance after claim', { balance: balanceAfter.toString() });

  const deltaRaw = balanceAfter - balanceBefore;
  if (deltaRaw <= BigInt(0)) {
    logger.info('No fees to claim (delta = 0)');
    await logEvent('claim_completed', 'No fees available to claim', {
      txSignature,
      delta: '0',
    });
    return null;
  }

  const amountSol = formatSolAmount(deltaRaw);
  logger.info('Fees claimed successfully', { amountSol, txSignature });

  const insertResult = await pool.query<{ id: number }>(
    `INSERT INTO claim_rounds (tx_signature, amount_usdc, fee_account, status)
     VALUES ($1, $2, $3, 'completed') RETURNING id`,
    [txSignature, amountSol, AMM_CREATOR_VAULT.toBase58()]
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
}

function formatSolAmount(rawAmount: bigint): string {
  const whole = rawAmount / BigInt(1_000_000_000);
  const fraction = rawAmount % BigInt(1_000_000_000);
  const fractionStr = fraction.toString().padStart(9, '0');
  return `${whole}.${fractionStr}`;
}
