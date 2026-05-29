import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../config';
import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import { getConnection } from '../utils/solana';

export interface HolderInfo {
  wallet: string;
  tokenBalance: string;
  percentage: string;
}

export interface SnapshotResult {
  snapshotId: number;
  holders: HolderInfo[];
  totalSupply: string;
  holderCount: number;
}

async function logEvent(type: string, message: string, data?: Record<string, unknown>): Promise<void> {
  await pool.query(
    'INSERT INTO events (type, message, data) VALUES ($1, $2, $3)',
    [type, message, data ? JSON.stringify(data) : null]
  );
}

export async function takeSnapshot(): Promise<SnapshotResult> {
  const connection = getConnection();
  logger.info('Taking holder snapshot...');

  // Get all token accounts for this mint — try both Token Program and Token-2022
  const [classicAccounts, token2022Accounts] = await Promise.all([
    connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: config.tokenMint.toBase58() } },
      ],
    }).catch(() => []),
    connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: config.tokenMint.toBase58() } },
      ],
    }).catch(() => []),
  ]);

  const accounts = [...classicAccounts, ...token2022Accounts];

  logger.info(`Found ${accounts.length} token accounts`, {
    classic: classicAccounts.length,
    token2022: token2022Accounts.length,
  });

  // Build exclusion set
  const exclusionSet = new Set<string>([
    config.walletPublicKey.toBase58(),
    config.pumpAmm.toBase58(),
    config.feeAccount.toBase58(),
  ]);

  // Dynamically exclude bonding curve and associated bonding curve
  // Fetch from pump.fun API
  try {
    const response = await fetch(
      `https://frontend-api-v3.pump.fun/coins/${config.tokenMint.toBase58()}`
    );
    if (response.ok) {
      const data = await response.json() as Record<string, string>;
      if (data.bonding_curve) {
        exclusionSet.add(data.bonding_curve);
        logger.info('Excluding bonding curve', { address: data.bonding_curve });
      }
      if (data.associated_bonding_curve) {
        exclusionSet.add(data.associated_bonding_curve);
        logger.info('Excluding associated bonding curve', { address: data.associated_bonding_curve });
      }
    }
  } catch {
    logger.warn('Could not fetch bonding curve info from pump.fun API');
  }

  // Parse accounts
  const holders: Array<{ wallet: string; rawBalance: bigint }> = [];
  let totalEligibleSupply = BigInt(0);

  for (const account of accounts) {
    const data = account.account.data;

    // Owner: bytes 32-64
    const ownerBytes = data.subarray(32, 64);
    const owner = new PublicKey(ownerBytes).toBase58();

    // Amount: bytes 64-72 (u64 LE)
    const amountBytes = data.subarray(64, 72);
    const rawAmount = readU64LE(amountBytes);

    if (rawAmount === BigInt(0)) continue;

    // Convert to real balance (6 decimals)
    const realBalance = Number(rawAmount) / 1_000_000;

    // Exclude system accounts and below minimum
    if (exclusionSet.has(owner)) continue;
    if (realBalance < config.minHolding) continue;

    holders.push({ wallet: owner, rawBalance: rawAmount });
    totalEligibleSupply += rawAmount;
  }

  logger.info(`Qualified holders: ${holders.length}`, {
    totalEligibleSupply: formatTokenAmount(totalEligibleSupply),
  });

  // Calculate percentages and insert into DB
  const totalSupplyStr = formatTokenAmount(totalEligibleSupply);

  const snapshotResult = await pool.query<{ id: number }>(
    `INSERT INTO snapshots (holder_count, total_supply, token_mint)
     VALUES ($1, $2, $3) RETURNING id`,
    [holders.length, totalSupplyStr, config.tokenMint.toBase58()]
  );
  const snapshotId = snapshotResult.rows[0].id;

  const holderInfos: HolderInfo[] = [];

  for (const holder of holders) {
    const percentage = totalEligibleSupply > BigInt(0)
      ? (Number(holder.rawBalance) / Number(totalEligibleSupply)) * 100
      : 0;
    const tokenBalance = formatTokenAmount(holder.rawBalance);
    const percentageStr = percentage.toFixed(6);

    await pool.query(
      `INSERT INTO snapshot_holders (snapshot_id, wallet, token_balance, percentage)
       VALUES ($1, $2, $3, $4)`,
      [snapshotId, holder.wallet, tokenBalance, percentageStr]
    );

    holderInfos.push({
      wallet: holder.wallet,
      tokenBalance,
      percentage: percentageStr,
    });
  }

  await logEvent('snapshot_taken', `Snapshot taken: ${holders.length} qualified holders`, {
    snapshotId,
    holderCount: holders.length,
    totalSupply: totalSupplyStr,
  });

  return {
    snapshotId,
    holders: holderInfos,
    totalSupply: totalSupplyStr,
    holderCount: holders.length,
  };
}

function readU64LE(buffer: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = 0; i < 8; i++) {
    result += BigInt(buffer[i]) << BigInt(i * 8);
  }
  return result;
}

function formatTokenAmount(rawAmount: bigint): string {
  const whole = rawAmount / BigInt(1_000_000);
  const fraction = rawAmount % BigInt(1_000_000);
  const fractionStr = fraction.toString().padStart(6, '0');
  return `${whole}.${fractionStr}`;
}
