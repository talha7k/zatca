/**
 * Invoice Hash Chain Management
 *
 * ZATCA requires each invoice to contain a SHA-256 hash linking it
 * to the previous invoice. This forms an immutable chain that
 * prevents retroactive modification of submitted invoices.
 *
 * Chain formula: SHA-256(canonicalXml + previousHash)
 * - First invoice: previousHash is empty string
 * - Subsequent invoices: previousHash = hash of the prior invoice
 */

import crypto from 'node:crypto';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type { HashChainState } from '../types.js';

/**
 * Compute the next hash in the invoice hash chain.
 *
 * @param canonicalXml - The canonical XML string of the current invoice
 * @param previousHash - The hash of the previous invoice (empty string for first invoice)
 * @returns SHA-256 hex digest of (canonicalXml + previousHash)
 */
export function computeNextHash(canonicalXml: string, previousHash: string): string {
  if (!canonicalXml) {
    throw new ZatcaError(
      'canonicalXml is required to compute hash',
      ZatcaErrorCode.HASH_CHAIN_ERROR,
    );
  }

  const prev = previousHash || '';
  const combined = canonicalXml + prev;
  return crypto.createHash('sha256').update(combined, 'utf8').digest('hex');
}

/**
 * Initialize hash chain for a new organization.
 *
 * Returns the initial state with empty lastHash and counter 0.
 */
export function initializeHashChain(): HashChainState {
  return {
    lastHash: '',
    lastUuid: '',
    counter: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Advance the hash chain after a successful invoice submission.
 *
 * @param currentState - The current chain state
 * @param newHash - The computed hash of the newly submitted invoice
 * @param newUuid - The UUID of the newly submitted invoice
 * @returns Updated chain state with incremented counter
 */
export function advanceHashChain(
  currentState: HashChainState,
  newHash: string,
  newUuid: string,
): HashChainState {
  if (!newHash) {
    throw new ZatcaError(
      'newHash is required to advance hash chain',
      ZatcaErrorCode.HASH_CHAIN_ERROR,
    );
  }

  if (!newUuid) {
    throw new ZatcaError(
      'newUuid is required to advance hash chain',
      ZatcaErrorCode.HASH_CHAIN_ERROR,
    );
  }

  return {
    lastHash: newHash,
    lastUuid: newUuid,
    counter: currentState.counter + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Validate hash chain integrity across a list of invoices.
 *
 * Checks that:
 * - The first invoice has no previous hash (or empty)
 * - Each subsequent invoice's previousHash matches the prior invoice's hash
 *
 * @param invoices - Ordered list of invoices with hash and previousHash
 * @returns Validation result with details if chain is broken
 */
export function validateHashChain(
  invoices: Array<{ hash: string; previousHash: string }>,
): { valid: boolean; brokenAtIndex?: number; message: string } {
  if (invoices.length === 0) {
    return { valid: true, message: 'No invoices to validate' };
  }

  const first = invoices[0];
  if (first.previousHash && first.previousHash !== '') {
    return {
      valid: false,
      brokenAtIndex: 0,
      message: 'First invoice should not have a previous hash',
    };
  }

  for (let i = 1; i < invoices.length; i++) {
    const current = invoices[i];
    const previous = invoices[i - 1];

    if (current.previousHash !== previous.hash) {
      return {
        valid: false,
        brokenAtIndex: i,
        message: `Hash chain broken at invoice ${i}: expected ${previous.hash}, got ${current.previousHash}`,
      };
    }
  }

  return { valid: true, message: `Chain valid with ${invoices.length} invoices` };
}
