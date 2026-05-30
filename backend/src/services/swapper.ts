import {
  PublicKey,
  TransactionInstruction,
  Connection,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getConnection } from '../utils/solana';

export interface SwapResult {
  amountTokens: string;
  txSignature: string;
}

// ── Jupiter API ──────────────────────────────────────────────────────────────
const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const CUM_MINT = config.rewardMint.toBase58();

interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  routePlan: unknown[];
}

// ── Balance helper ───────────────────────────────────────────────────────────

async function getCumBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const info = await connection.getTokenAccountBalance(ata, 'confirmed');
    return BigInt(info.value.amount);
  } catch {
    return BigInt(0);
  }
}

// ── Main swap function (Jupiter) ─────────────────────────────────────────────

export async function swapSolForCum(amountSol: string): Promise<SwapResult | null> {
  const connection = getConnection();

  try {
    const lamports = parseSolToLamports(amountSol);
    if (lamports <= BigInt(0)) {
      logger.warn('Swap amount is 0, skipping');
      return null;
    }

    logger.info('Starting SOL → $CUM swap via Jupiter', { amountSol, lamports: lamports.toString() });

    // Step 1: Get quote from Jupiter
    const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${WSOL_MINT}&outputMint=${CUM_MINT}&amount=${lamports.toString()}&slippageBps=500`;
    const quoteResp = await fetch(quoteUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!quoteResp.ok) {
      const text = await quoteResp.text();
      throw new Error(`Jupiter quote failed: ${quoteResp.status} ${text}`);
    }

    const quote: JupiterQuote = await quoteResp.json() as JupiterQuote;
    logger.info('Jupiter quote received', {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      minOut: quote.otherAmountThreshold,
      routes: quote.routePlan?.length ?? 0,
    });

    if (BigInt(quote.outAmount) <= BigInt(0)) {
      logger.warn('Jupiter quote returned 0 output, skipping');
      return null;
    }

    // Step 2: Get swap transaction from Jupiter
    const swapResp = await fetch(JUPITER_SWAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: config.walletPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 100000,
      }),
    });

    if (!swapResp.ok) {
      const text = await swapResp.text();
      throw new Error(`Jupiter swap failed: ${swapResp.status} ${text}`);
    }

    const swapData = await swapResp.json() as { swapTransaction: string };
    if (!swapData.swapTransaction) {
      throw new Error('Jupiter returned no swap transaction');
    }

    // Step 3: Deserialize, sign, and send
    const userCumAta = getAssociatedTokenAddressSync(config.rewardMint, config.walletPublicKey, false, TOKEN_2022_PROGRAM_ID);
    const cumBefore = await getCumBalance(connection, userCumAta);

    const swapTxBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([config.walletKeypair]);

    logger.info('Sending Jupiter swap transaction...');
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    logger.info('Transaction sent', { signature });

    // Step 4: Confirm
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction confirmed with error: ${JSON.stringify(confirmation.value.err)}`);
    }

    logger.info('Transaction confirmed', { signature });

    // Step 5: Calculate tokens received
    await new Promise(resolve => setTimeout(resolve, 2000));
    const cumAfter = await getCumBalance(connection, userCumAta);
    const tokensReceived = cumAfter > cumBefore ? cumAfter - cumBefore : BigInt(0);

    const amountTokens = formatTokenAmount(tokensReceived);
    logger.info('Swap completed', { amountSol, amountTokens, txSignature: signature });

    return { amountTokens, txSignature: signature };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : (typeof err === 'object' ? JSON.stringify(err) : String(err));
    logger.error('SOL → $CUM swap failed', { error: errorMessage, stack: err instanceof Error ? err.stack : undefined });
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
