import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  Connection,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getConnection, sendTransactionWithRetry } from '../utils/solana';

export interface SwapResult {
  amountTokens: string;
  txSignature: string;
}

// PumpSwap buy discriminator: sha256("global:buy")[:8]
const BUY_DISCRIMINATOR = Buffer.from('66063d1201daebea', 'hex');

const [GLOBAL_CONFIG] = PublicKey.findProgramAddressSync(
  [Buffer.from('global_config')],
  config.pumpswapProgram
);

const [SWAP_EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  config.pumpswapProgram
);

let cachedPoolAddress: PublicKey | null = null;

async function getPoolAddress(): Promise<PublicKey> {
  if (cachedPoolAddress) return cachedPoolAddress;

  try {
    const url = `https://frontend-api-v3.pump.fun/coins/${config.rewardMint.toBase58()}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      // Try various field names the pump.fun API might use
      const poolAddr = data['raydium_pool'] || data['amm_pool'] || data['pool'];
      if (poolAddr && typeof poolAddr === 'string') {
        logger.info('Pool address from API', { pool: poolAddr });
        cachedPoolAddress = new PublicKey(poolAddr);
        return cachedPoolAddress;
      }
    }
  } catch (err) {
    logger.warn('Failed to fetch pool address from API, falling back to PDA derivation', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: derive pool PDA — seeds: ["pool", index_u16_le=0, base_mint=WSOL, quote_mint=$CUM]
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(0, 0);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), indexBuf, config.wsolMint.toBuffer(), config.rewardMint.toBuffer()],
    config.pumpswapProgram
  );
  logger.info('Derived pool PDA', { pool: poolPda.toBase58() });
  cachedPoolAddress = poolPda;
  return poolPda;
}

function buildBuyInstruction(
  poolAddress: PublicKey,
  wsolAmountLamports: bigint,
  minTokensOut: bigint
): TransactionInstruction {
  const userWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);
  const userCumAta = getAssociatedTokenAddressSync(config.rewardMint, config.walletPublicKey);
  // Pool owns its own token accounts as ATAs
  const poolWsolAta = getAssociatedTokenAddressSync(config.wsolMint, poolAddress, true);
  const poolCumAta = getAssociatedTokenAddressSync(config.rewardMint, poolAddress, true);
  // Protocol fee recipient WSOL ATA
  const feeWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.feeAccount);

  const data = Buffer.alloc(24);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(wsolAmountLamports, 8);
  data.writeBigUInt64LE(minTokensOut, 16);

  return new TransactionInstruction({
    programId: config.pumpswapProgram,
    keys: [
      { pubkey: poolAddress, isSigner: false, isWritable: true },
      { pubkey: config.walletPublicKey, isSigner: true, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: config.wsolMint, isSigner: false, isWritable: false },
      { pubkey: config.rewardMint, isSigner: false, isWritable: false },
      { pubkey: poolWsolAta, isSigner: false, isWritable: true },
      { pubkey: poolCumAta, isSigner: false, isWritable: true },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: userCumAta, isSigner: false, isWritable: true },
      { pubkey: config.feeAccount, isSigner: false, isWritable: true },
      { pubkey: feeWsolAta, isSigner: false, isWritable: true },
      // base_token_program then quote_token_program (both SPL Token for WSOL and pump.fun tokens)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: config.pumpswapProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function getCumBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const info = await connection.getTokenAccountBalance(ata, 'confirmed');
    return BigInt(info.value.amount);
  } catch {
    return BigInt(0);
  }
}

export async function swapSolForCum(amountSol: string): Promise<SwapResult | null> {
  const connection = getConnection();

  try {
    const lamports = parseSolToLamports(amountSol);
    if (lamports <= BigInt(0)) {
      logger.warn('Swap amount is 0, skipping');
      return null;
    }

    logger.info('Starting SOL → $CUM swap', { amountSol });

    const poolAddress = await getPoolAddress();
    const userWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);
    const userCumAta = getAssociatedTokenAddressSync(config.rewardMint, config.walletPublicKey);

    // Read $CUM balance before swap (ATA may not exist yet)
    const cumBefore = await getCumBalance(connection, userCumAta);

    const instructions: TransactionInstruction[] = [
      // 1. Create WSOL ATA (idempotent)
      createAssociatedTokenAccountIdempotentInstruction(
        config.walletPublicKey, userWsolAta, config.walletPublicKey, config.wsolMint
      ),
      // 2. Move native SOL into the WSOL ATA
      SystemProgram.transfer({
        fromPubkey: config.walletPublicKey,
        toPubkey: userWsolAta,
        lamports,
      }),
      // 3. Sync so the token balance reflects the deposited lamports
      createSyncNativeInstruction(userWsolAta),
      // 4. Create $CUM ATA (idempotent)
      createAssociatedTokenAccountIdempotentInstruction(
        config.walletPublicKey, userCumAta, config.walletPublicKey, config.rewardMint
      ),
      // 5. Buy $CUM with WSOL via PumpSwap
      buildBuyInstruction(poolAddress, lamports, BigInt(0)),
      // 6. Close WSOL ATA — returns any unspent WSOL rent/dust as native SOL
      createCloseAccountInstruction(userWsolAta, config.walletPublicKey, config.walletPublicKey),
    ];

    const result = await sendTransactionWithRetry(instructions, [config.walletKeypair], 3);

    // Give the node a moment to reflect the updated balance
    await new Promise(resolve => setTimeout(resolve, 2000));
    const cumAfter = await getCumBalance(connection, userCumAta);
    const tokensReceived = cumAfter > cumBefore ? cumAfter - cumBefore : BigInt(0);

    const amountTokens = formatTokenAmount(tokensReceived);
    logger.info('Swap completed', { amountSol, amountTokens, txSignature: result.signature });

    return { amountTokens, txSignature: result.signature };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('SOL → $CUM swap failed', { error: errorMessage });
    // Invalidate cached pool so we re-fetch next cycle in case pool lookup was wrong
    cachedPoolAddress = null;
    return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseSolToLamports(amount: string): bigint {
  const parts = amount.split('.');
  const whole = BigInt(parts[0] || '0') * BigInt(1_000_000_000);
  const fraction = parts[1] ? BigInt(parts[1].padEnd(9, '0').slice(0, 9)) : BigInt(0);
  return whole + fraction;
}

export function formatTokenAmount(rawAmount: bigint): string {
  const whole = rawAmount / BigInt(1_000_000);
  const fraction = rawAmount % BigInt(1_000_000);
  return `${whole}.${fraction.toString().padStart(6, '0')}`;
}

export function parseTokenAmountToRaw(amount: string): bigint {
  const parts = amount.split('.');
  const whole = BigInt(parts[0] || '0') * BigInt(1_000_000);
  const fraction = parts[1] ? BigInt(parts[1].padEnd(6, '0').slice(0, 6)) : BigInt(0);
  return whole + fraction;
}
