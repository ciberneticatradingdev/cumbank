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

// ── PumpAMM constants ────────────────────────────────────────────────────────
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Anchor "buy" discriminator: sha256("global:buy")[:8]
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

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

// Global volume accumulator PDA
const [GLOBAL_VOLUME_ACCUMULATOR] = PublicKey.findProgramAddressSync(
  [Buffer.from('global_volume_accumulator')],
  PUMP_AMM_PROGRAM
);

// Fee config PDA: seeds = ["fee_config", <32-byte constant>] on the fee program.
// The 32-byte constant is the pump.fun address-config discriminant.
const FEE_CONFIG_SEED_CONST = Buffer.from([
  12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24,
  187, 101, 64, 101, 244, 41, 141, 49, 86, 213, 113, 180,
  212, 248, 9, 12, 24, 233, 168, 99,
]);
const [PUMP_AMM_FEE_CONFIG] = PublicKey.findProgramAddressSync(
  [Buffer.from('fee_config'), FEE_CONFIG_SEED_CONST],
  FEE_PROGRAM
);

// ── Pool info ────────────────────────────────────────────────────────────────

interface PoolInfo {
  address: PublicKey;
  creator: PublicKey;      // pool creator (offset 11)
  coinCreator: PublicKey;  // coin creator for fee vault (offset 211 in Pump AMM)
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  protocolFeeRecipient: PublicKey;
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

  // Step 2: Read pool account on-chain
  // PumpAMM Pool layout:
  // [0..8]     discriminator
  // [8]        pool_bump (1 byte)
  // [9..11]    index (2 bytes)
  // [11..43]   creator (32 bytes)
  // [43..75]   base_mint (32 bytes)
  // [75..107]  quote_mint (32 bytes)
  // [107..139] lp_mint (32 bytes)
  // [139..171] pool_base_token_account (32 bytes)
  // [171..203] pool_quote_token_account (32 bytes)
  // [203..211] lp_supply (u64) — legacy; Pump AMM: lp_fee_basis_points
  // [211..243] coin_creator (32 bytes) — Pump AMM specific
  const accountInfo = await connection.getAccountInfo(poolAddress);
  if (!accountInfo) throw new Error('Pool account not found on-chain');
  if (accountInfo.data.length < 243) throw new Error(`Pool account data too short: ${accountInfo.data.length}`);

  const data = accountInfo.data;
  const readPubkey = (offset: number) => new PublicKey(data.slice(offset, offset + 32));

  // Step 3: Read protocol_fee_recipient from global config
  // Layout: disc(8) + admin(32) + lp_fee(8) + proto_fee(8) + flags(1) + recipients([Pubkey;8])
  // The protocol uses one active recipient from the array.
  // We select recipient[4] which matches current pump.fun production swaps.
  // If this stops working, check recent successful PumpAMM swaps for the active recipient.
  const globalConfigInfo = await connection.getAccountInfo(GLOBAL_CONFIG);
  if (!globalConfigInfo) throw new Error('Global config not found on-chain');

  const gcData = globalConfigInfo.data;
  const recipientIndex = 4; // Current active recipient index in pump.fun production
  const recipientOffset = 57 + recipientIndex * 32;
  if (recipientOffset + 32 > gcData.length) throw new Error('Global config too short for recipient');
  const protocolFeeRecipient = new PublicKey(gcData.slice(recipientOffset, recipientOffset + 32));

  cachedPool = {
    address: poolAddress,
    creator: readPubkey(11),
    coinCreator: readPubkey(211),
    baseMint: readPubkey(43),
    quoteMint: readPubkey(75),
    poolBaseTokenAccount: readPubkey(139),
    poolQuoteTokenAccount: readPubkey(171),
    protocolFeeRecipient,
  };

  logger.info('Pool parsed from on-chain data', {
    pool: cachedPool.address.toBase58(),
    creator: cachedPool.creator.toBase58(),
    coinCreator: cachedPool.coinCreator.toBase58(),
    baseMint: cachedPool.baseMint.toBase58(),
    quoteMint: cachedPool.quoteMint.toBase58(),
    poolBase: cachedPool.poolBaseTokenAccount.toBase58(),
    poolQuote: cachedPool.poolQuoteTokenAccount.toBase58(),
    feeRecipient: cachedPool.protocolFeeRecipient.toBase58(),
  });

  return cachedPool;
}

// ── PDA derivations ──────────────────────────────────────────────────────────

function deriveCoinCreatorVault(coinCreator: PublicKey) {
  // PDA["creator_vault", coin_creator] — note: "creator_vault" not "creator-vault"
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM
  );
  const vaultAta = getAssociatedTokenAddressSync(config.wsolMint, vaultAuthority, true);
  return { vaultAuthority, vaultAta };
}

function deriveUserVolumeAccumulator(user: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_AMM_PROGRAM
  );
  return pda;
}

// ── Build buy instruction ────────────────────────────────────────────────────
// Pump AMM "buy" instruction: 23 accounts
// Receives base tokens (e.g. $CUM), paying with quote tokens (e.g. WSOL)
// Args: base_amount_out (min tokens to receive), max_quote_amount_in (max WSOL to spend)
// IMPORTANT: base_amount_out MUST be > 0 or the program rejects with ZeroBaseAmount (6001)

async function calculateExpectedOutput(
  connection: Connection,
  poolInfo: PoolInfo,
  quoteAmountIn: bigint,
): Promise<bigint> {
  // Read pool vault balances to calculate expected output
  const [baseBalance, quoteBalance] = await Promise.all([
    connection.getTokenAccountBalance(poolInfo.poolBaseTokenAccount, 'confirmed'),
    connection.getTokenAccountBalance(poolInfo.poolQuoteTokenAccount, 'confirmed'),
  ]);

  const baseReserve = BigInt(baseBalance.value.amount);
  const quoteReserve = BigInt(quoteBalance.value.amount);

  if (baseReserve <= BigInt(0) || quoteReserve <= BigInt(0)) {
    throw new Error('Pool has zero reserves');
  }

  // Constant product: amount_out = (base_reserve * amount_in_after_fee) / (quote_reserve + amount_in_after_fee)
  // Fee: lp_fee = 20 bps, protocol_fee = 5 bps = 25 bps total
  const totalFeeBps = BigInt(25);
  const fee = (quoteAmountIn * totalFeeBps) / BigInt(10000);
  const amountInAfterFee = quoteAmountIn - fee;

  const amountOut = (baseReserve * amountInAfterFee) / (quoteReserve + amountInAfterFee);

  logger.info('Swap calculation', {
    baseReserve: baseReserve.toString(),
    quoteReserve: quoteReserve.toString(),
    quoteIn: quoteAmountIn.toString(),
    fee: fee.toString(),
    expectedOut: amountOut.toString(),
  });

  return amountOut;
}

function buildBuyInstruction(
  poolInfo: PoolInfo,
  baseAmountOut: bigint,     // minimum base tokens to receive
  maxQuoteAmountIn: bigint,  // max WSOL lamports to spend
): TransactionInstruction {
  const userBaseAta = getAssociatedTokenAddressSync(config.rewardMint, config.walletPublicKey, false, TOKEN_2022_PROGRAM_ID);
  const userQuoteAta = getAssociatedTokenAddressSync(config.wsolMint, config.walletPublicKey);

  // Fee recipient ATA (WSOL ATA of the protocol fee recipient)
  const feeRecipientAta = getAssociatedTokenAddressSync(config.wsolMint, poolInfo.protocolFeeRecipient, true);

  // Coin creator vault (derived from coinCreator, not pool creator)
  const { vaultAuthority, vaultAta } = deriveCoinCreatorVault(poolInfo.coinCreator);
  const userVolumeAccumulator = deriveUserVolumeAccumulator(config.walletPublicKey);

  // Data: discriminator(8) + base_amount_out(u64) + max_quote_amount_in(u64) + track_volume(1 byte)
  const data = Buffer.alloc(25);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(baseAmountOut, 8);
  data.writeBigUInt64LE(maxQuoteAmountIn, 16);
  data.writeUInt8(1, 24); // track_volume = Some(true)

  // 23 accounts for buy instruction (matches reference implementation)
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    keys: [
      // 0-18: shared accounts (19)
      { pubkey: poolInfo.address, isSigner: false, isWritable: true },                    // 0  pool
      { pubkey: config.walletPublicKey, isSigner: true, isWritable: true },               // 1  user
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },                      // 2  global_config
      { pubkey: poolInfo.baseMint, isSigner: false, isWritable: false },                  // 3  base_mint ($CUM)
      { pubkey: poolInfo.quoteMint, isSigner: false, isWritable: false },                 // 4  quote_mint (WSOL)
      { pubkey: userBaseAta, isSigner: false, isWritable: true },                         // 5  user_base_token_account
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },                        // 6  user_quote_token_account
      { pubkey: poolInfo.poolBaseTokenAccount, isSigner: false, isWritable: true },       // 7  pool_base_token_account
      { pubkey: poolInfo.poolQuoteTokenAccount, isSigner: false, isWritable: true },      // 8  pool_quote_token_account
      { pubkey: poolInfo.protocolFeeRecipient, isSigner: false, isWritable: false },      // 9  protocol_fee_recipient
      { pubkey: feeRecipientAta, isSigner: false, isWritable: true },                     // 10 protocol_fee_recipient_ata
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },              // 11 base_token_program ($CUM = Token-2022)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                   // 12 quote_token_program (WSOL = Token Classic)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },            // 13 system_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // 14 associated_token_program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },                    // 15 event_authority
      { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },                   // 16 program (self-ref)
      { pubkey: vaultAta, isSigner: false, isWritable: true },                            // 17 coin_creator_vault_ata
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },                     // 18 coin_creator_vault_authority
      // 19-22: buy-specific accounts (4)
      { pubkey: GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },          // 19 global_volume_accumulator
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },               // 20 user_volume_accumulator
      { pubkey: PUMP_AMM_FEE_CONFIG, isSigner: false, isWritable: false },               // 21 fee_config
      { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },                        // 22 fee_program
    ],
    data,
  });
}

// ── Main swap function ───────────────────────────────────────────────────────

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

      // 5. Calculate expected output and buy $CUM via PumpAMM
      const expectedTokens = await calculateExpectedOutput(connection, poolInfo, lamports);
      if (expectedTokens <= BigInt(0)) {
        logger.warn('Expected 0 tokens from swap, skipping');
        return null;
      }
      // Use 50% slippage tolerance (small amounts, low liquidity)
      const minTokensOut = expectedTokens / BigInt(2);

      logger.info('Swap params', {
        lamportsIn: lamports.toString(),
        expectedTokens: expectedTokens.toString(),
        minTokensOut: minTokensOut.toString(),
      });

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
        // 4. Create $CUM ATA (idempotent, Token-2022)
        createAssociatedTokenAccountIdempotentInstruction(
          config.walletPublicKey, userCumAta, config.walletPublicKey, config.rewardMint, TOKEN_2022_PROGRAM_ID
        ),
        // 5. Buy $CUM via PumpAMM (minTokensOut, maxSolIn=lamports)
        buildBuyInstruction(poolInfo, minTokensOut, lamports),
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
