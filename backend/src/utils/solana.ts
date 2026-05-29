import {
  Connection,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
  ComputeBudgetProgram,
  SendOptions,
  TransactionSignature,
} from '@solana/web3.js';
import { config } from '../config';
import { logger } from './logger';

let connectionInstance: Connection | null = null;

export function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection(config.solanaRpcUrl, {
      commitment: 'confirmed',
    });
    logger.info('Solana connection initialized', { rpc: config.solanaRpcUrl.substring(0, 30) + '...' });
  }
  return connectionInstance;
}

export interface SendTransactionResult {
  signature: TransactionSignature;
  confirmed: boolean;
}

export async function sendTransactionWithRetry(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  maxRetries: number = 3
): Promise<SendTransactionResult> {
  const connection = getConnection();
  const backoffMs = [1000, 2000, 4000];

  // Add priority fees
  const allInstructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...instructions,
  ];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      const messageV0 = new TransactionMessage({
        payerKey: signers[0].publicKey,
        recentBlockhash: blockhash,
        instructions: allInstructions,
      }).compileToV0Message();

      const tx = new VersionedTransaction(messageV0);
      tx.sign(signers);

      logger.info(`Sending transaction attempt ${attempt + 1}/${maxRetries}`);
      const signature = await connection.sendTransaction(tx, {
        skipPreflight: true,
        maxRetries: 0,
      });
      logger.info('Transaction sent', { signature });

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      logger.info('Transaction confirmed', { signature });
      return { signature, confirmed: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Transaction attempt ${attempt + 1} failed`, { error: errorMessage });

      if (attempt < maxRetries - 1) {
        const delay = backoffMs[attempt] || 4000;
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }

  throw new Error('All transaction attempts exhausted');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
