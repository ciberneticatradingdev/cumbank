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
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getConnection, sendTransactionWithRetry } from '../utils/solana';

export interface SwapResult {
  amountTokens: string;
  txSignature: string;
}

// ── PumpAMM program (the actual swap program) ────────────────────────────────
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// Fee program
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// buy_exact_quote_in discriminator: [198, 46, 21, 82, 180, 217, 232, 112]
const BUY_EXACT_QUOTE_IN_DISC = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);

// Global config PDA for PumpAMM
const [GLOBAL_CONFIG] = PublicKey.findProgramAddressSync(
  [Buffer.from('global_config')],
  PUMP_AMM_PROGRAM
);

// Event authority PDA for PumpAMM
const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  PUMP_AMM_PROGRAM
);

interface PoolInfo {
  address: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
}

let cachedPool: PoolInfo | null = null;

async function getPoolInfo(): Promise<PoolInfo> {
  if (cachedPool) return cachedPool;

  const connection = getConnection();

  // Step 1: Get pool address from pump.fun API
  let poolAddress: PublicKey;
  try {
    const url = `https://frontend-api-v3.pump.fun/coins/${config.rewardMint.toBase58()}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      const poolAddr = data['pump_swap_pool'] || data['pool_address'] || data['raydium_pool'];
      if (poolAddr && typeof poolAddr === 'string') {
        logger.info('Pool address from API', { pool: poolAddr });
        poolAddress = new PublicKey(poolAddr);
      } else {
        throw new Error('No pool address in API response');
      }
    } else {
      throw new Error(`API returned ${resp.status}`);
    }
  } catch (err) {
    throw new Error(`Could not determine pool address: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Read pool account on-chain to get ACTUAL token accounts
  // PumpAMM Pool layout:
  // [0..8]    discriminator
  // [8]       pool_bump (1 byte)
  // [9..11]   index (2 bytes)
  // [11..43]  creator (32 bytes)
  // [43..75]  base_mint (32 bytes)
  // [75..107] quote_mint (32 bytes)
  // [107..139] lp_mint (32 bytes)
  // [139..171] pool_base_token_account (32 bytes)
  // [171..203] pool_quote_token_account (32 bytes)
  const accountInfo = await connection.getAccountInfo(poolAddress);
  if (!accountInfo) throw new Error('Pool account not found on-chain');
  if (accountInfo.data.length < 203) throw new Error(`Pool account data too short: ${accountInfo.data.length}`);

  const data = accountInfo.data;
  const readPubkey = (offset: number) => new PublicKey(data.slice(offset, offset + 32));

  cachedPool = {
    address: poolAddress,
    creator: readPubkey(11),
    baseMint: readPubkey(43),
    quoteMint: readPubkey(75),
    poolBaseTokenAccount: readPubkey(139),
    poolQuoteTokenAccount: readPubkey(171),
  };

  logger.info('Pool parsed from on-chain data', {
    pool: cachedPool.address.toBase58(),
    creator: cachedPool.creator.toBase58(),
    baseMint: cachedPool.baseMint.toBase58(),
    quoteMint: cachedPool.quoteMint.toBase58(),
    poolBase: cachedPool.poolBaseTokenAccount.toBase58(),
    poolQuote: cachedPool.poolQuoteTokenAccount.toBase58(),
  });

  return cachedPool;
}

function deriveCoinCreatorVault(coinCreator: PublicKey) {
  // Creator vault PDA on PumpAMM
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM
  );
  const vaultAta = getAssociatedTokenAddressSync(config.wsolMint, vaultAuthority, true);
  return { vaultAuthority, vaultAta };
}

function deriveGlobalVolumeAccumulator() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_AMM_PROGRAM
  );
  return pda;
}

function deriveUserVolumeAccumulator(user: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_AMM_PROGRAM
  );
  return pda;
}

function deriveFeeConfig() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config')],
    FEE_PROGRAM
  );
  return pda;
}

function buildBuyExactQuoteIn(
  poolInfo: PoolInfo,
  quoteAmountIn: bigint,   // lamports of WSOL to spend
  minBaseOut: bigint,       // minimum $CUM tokens to receive (0 = no slippage protection)
): TransactionInstruction {
  const userBaseAta = getAssociatedTokenAddressSync(config.rewardMint, config.walletPublicKey, false, TOKEN_2022_PROGRAM_ID);
  const userQuoteAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);
  
  // Use ACTUAL on-chain pool token accounts (not derived ATAs)
  const poolBaseAta = poolInfo.poolBaseTokenAccount;
  const poolQuoteAta = poolInfo.poolQuoteTokenAccount;
  
  // Protocol fee recipient = the fee account from config
  const protocolFeeRecipient = config.feeAccount;
  const protocolFeeQuoteAta = getAssociatedTokenAddressSync(config.wsolMint, protocolFeeRecipient, true);

  const { vaultAuthority, vaultAta } = deriveCoinCreatorVault(poolInfo.creator);
  const globalVolumeAccumulator = deriveGlobalVolumeAccumulator();
  const userVolumeAccumulator = deriveUserVolumeAccumulator(config.walletPublicKey);
  const feeConfig = deriveFeeConfig();

  // Data: discriminator (8) + spendable_quote_in (u64) + min_base_amount_out (u64) + track_volume (1 byte OptionBool: 0=None)
  const data = Buffer.alloc(25);
  BUY_EXACT_QUOTE_IN_DISC.copy(data, 0);
  data.writeBigUInt64LE(quoteAmountIn, 8);
  data.writeBigUInt64LE(minBaseOut, 16);
  data.writeUInt8(0, 24); // OptionBool::None (don't track volume)

  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    keys: [
      { pubkey: poolInfo.address, isSigner: false, isWritable: true },                    // pool
      { pubkey: config.walletPublicKey, isSigner: true, isWritable: true },          // user
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },                 // global_config
      { pubkey: config.rewardMint, isSigner: false, isWritable: false },             // base_mint ($CUM)
      { pubkey: config.wsolMint, isSigner: false, isWritable: false },               // quote_mint (WSOL)
      { pubkey: userBaseAta, isSigner: false, isWritable: true },                    // user_base_token_account
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },                   // user_quote_token_account
      { pubkey: poolBaseAta, isSigner: false, isWritable: true },                    // pool_base_token_account
      { pubkey: poolQuoteAta, isSigner: false, isWritable: true },                   // pool_quote_token_account
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },          // protocol_fee_recipient
      { pubkey: protocolFeeQuoteAta, isSigner: false, isWritable: true },            // protocol_fee_recipient_token_account
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },          // base_token_program ($CUM = Token-2022)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },              // quote_token_program (WSOL = Token Program)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },       // system_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },   // associated_token_program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },               // event_authority
      { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },              // program (self-ref)
      { pubkey: vaultAta, isSigner: false, isWritable: true },                       // coin_creator_vault_ata
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },                // coin_creator_vault_authority
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },       // global_volume_accumulator
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },          // user_volume_accumulator
      { pubkey: feeConfig, isSigner: false, isWritable: false },                     // fee_config
      { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },                   // fee_program
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

    const poolInfo = await getPoolInfo();

    const userWsolAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);
    const userCumAta = getAssociatedTokenAddressSync(config.rewardMint, config.walletPublicKey, false, TOKEN_2022_PROGRAM_ID);

    // Read $CUM balance before swap
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
        config.walletPublicKey, userCumAta, config.walletPublicKey, config.rewardMint, TOKEN_2022_PROGRAM_ID
      ),
      // 5. Buy $CUM with WSOL via PumpAMM buy_exact_quote_in (using on-chain pool data)
      buildBuyExactQuoteIn(poolInfo, lamports, BigInt(0)),
      // 6. Close WSOL ATA — returns any unspent WSOL as native SOL
      createCloseAccountInstruction(userWsolAta, config.walletPublicKey, config.walletPublicKey),
    ];

    const result = await sendTransactionWithRetry(instructions, [config.walletKeypair], 3);

    // Wait for balance to update
    await new Promise(resolve => setTimeout(resolve, 2000));
    const cumAfter = await getCumBalance(connection, userCumAta);
    const tokensReceived = cumAfter > cumBefore ? cumAfter - cumBefore : BigInt(0);

    const amountTokens = formatTokenAmount(tokensReceived);
    logger.info('Swap completed', { amountSol, amountTokens, txSignature: result.signature });

    return { amountTokens, txSignature: result.signature };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
    logger.error('SOL → $CUM swap failed', { error: errorMessage, stack: err instanceof Error ? err.stack : undefined });
    // Invalidate cached pool
    cachedPool = null;
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