import {
  HttpException,
  InternalServerErrorException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import type { Connection, ClientSession } from 'mongoose';
import { randomUUID } from 'crypto';
import { redactString } from '../common/logging/app-logger.service.js';

export interface TransactionOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxCommitRetries?: number;
}

const logger = new Logger('DatabaseTransaction');

async function commitWithRetry(
  session: ClientSession,
  maxCommitRetries: number,
  baseDelayMs: number,
  maxDelayMs: number,
  correlationId: string,
): Promise<void> {
  for (let commitAttempt = 1; commitAttempt <= maxCommitRetries; commitAttempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (err: any) {
      const isUnknownCommit = err?.hasErrorLabel?.('UnknownTransactionCommitResult');
      if (isUnknownCommit) {
        if (commitAttempt < maxCommitRetries) {
          const backoff = Math.min(baseDelayMs * Math.pow(2, commitAttempt - 1), maxDelayMs);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue; // Retry commitTransaction ONLY; never re-run business operation
        }
        logger.error(
          `[${correlationId}] UnknownTransactionCommitResult exhausted after ${maxCommitRetries} commit retries. Transaction outcome is ambiguous. Primary database state may be committed.`,
        );
        throw new InternalServerErrorException(
          'Transaction status uncertain: the database commit outcome could not be verified after maximum retries. Please inspect the clinic status before retrying.',
        );
      }
      throw err;
    }
  }
}

export async function executeInTransaction<T>(
  connection: Connection,
  operation: (session: ClientSession) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 500;
  const maxCommitRetries = options.maxCommitRetries ?? 3;
  const correlationId = randomUUID();

  const session = await connection.startSession();

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });

        // Execute pure database operations
        const result = await operation(session);

        // Commit transaction with dedicated commit-retry logic
        await commitWithRetry(session, maxCommitRetries, baseDelayMs, maxDelayMs, correlationId);

        return result;
      } catch (err: any) {
        if (session.inTransaction()) {
          try {
            await session.abortTransaction();
          } catch {
            // Abort error ignored; handled below
          }
        }

        // 1. Preserve expected application exceptions intact (400, 401, 403, 404, 409, 410, 502)
        if (err instanceof HttpException) {
          throw err;
        }

        // 2. Retry transient database errors
        const isTransient = err?.hasErrorLabel?.('TransientTransactionError') || err?.code === 112;
        if (isTransient) {
          if (attempt < maxRetries) {
            const jitter = Math.floor(Math.random() * 25);
            const backoff = Math.min(baseDelayMs * Math.pow(2, attempt - 1) + jitter, maxDelayMs);
            await new Promise((resolve) => setTimeout(resolve, backoff));
            continue; // Retry full transaction from startTransaction
          }
          logger.error(
            `[${correlationId}] Transaction retries exhausted after ${maxRetries} attempts due to write contention`,
          );
          throw new InternalServerErrorException(
            'Transaction aborted: maximum retry attempts reached due to database contention',
          );
        }

        // 3. Map duplicate unique index violations (E11000)
        if (err?.code === 11000) {
          throw new ConflictException('A resource with these unique attributes already exists');
        }

        // 4. Sanitize and log unexpected database/infrastructure errors
        const sanitizedMsg = redactString(err?.message || 'Database transaction error');
        logger.error(`[${correlationId}] Unexpected transaction error: ${sanitizedMsg}`);
        throw new InternalServerErrorException('A database error occurred while processing the request');
      }
    }
    throw new InternalServerErrorException('Transaction aborted: maximum retry attempts reached');
  } finally {
    await session.endSession();
  }
}
