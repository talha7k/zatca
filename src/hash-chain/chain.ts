/**
 * Invoice Hash Chain Management
 *
 * ZATCA requires each invoice to carry the SHA-256 hash of its own
 * canonicalized XML (the invoice hash) plus the Previous Invoice Hash (PIH)
 * linking it to the prior invoice. This forms an immutable chain that
 * prevents retroactive modification of submitted invoices.
 *
 * Chain formula (each invoice): Base64(SHA-256(canonicalized invoice XML))
 * - The PIH is carried INSIDE the document
 *   (cac:AdditionalDocumentReference ID="PIH") and is never part of the
 *   hash preimage.
 * - First invoice: PIH is the BR-KSA-26 genesis constant
 *   (`NWZlY2Vi...OQ==`, base64 of the UTF-8 hex string of sha256("0"),
 *   as mandated by the ZATCA SDK / BR-KSA-26 guidance).
 * - Subsequent invoices: PIH = invoice hash of the prior invoice.
 */

import crypto from 'node:crypto';
import { DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH } from '../compliance/index.js';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type { HashChainState } from '../types.js';

/**
 * Compute the ZATCA invoice hash: Base64(SHA-256(canonicalized invoice XML)).
 *
 * The Previous Invoice Hash (PIH) is carried inside the invoice XML and is
 * NOT part of the hash preimage.
 *
 * @param canonicalXml - The canonical XML string of the current invoice
 * @param _previousHash - @deprecated Ignored. Kept only for backwards
 *   compatibility with the previous (incorrect) signature; callers may still
 *   pass it and it has no effect on the result.
 * @returns Base64-encoded SHA-256 digest of the canonical XML (44 chars)
 */
export function computeNextHash(canonicalXml: string, _previousHash?: string): string {
  // The deprecated second parameter is intentionally unused: the ZATCA invoice
  // hash preimage is the canonicalized invoice XML alone (the PIH lives inside the document).
  if (!canonicalXml) {
    throw new ZatcaError(
      'canonicalXml is required to compute hash',
      ZatcaErrorCode.HASH_CHAIN_ERROR,
    );
  }

  return crypto.createHash('sha256').update(canonicalXml, 'utf8').digest('base64');
}

/**
 * Initialize hash chain for a new organization.
 *
 * Returns the initial state whose lastHash is the BR-KSA-26 genesis PIH
 * (the previous hash required on the first invoice of a chain) and whose
 * counter starts at 0.
 */
export function initializeHashChain(): HashChainState {
  return {
    lastHash: DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH,
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
 * - The first invoice carries the BR-KSA-26 genesis PIH
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
  if (first.previousHash !== DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH) {
    const got =
      first.previousHash === ''
        ? "'' (empty)"
        : `"${first.previousHash.slice(0, 16)}${first.previousHash.length > 16 ? '…' : ''}"`;
    return {
      valid: false,
      brokenAtIndex: 0,
      message: `First invoice previousHash must be the ZATCA genesis hash (BR-KSA-26); got ${got}`,
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
