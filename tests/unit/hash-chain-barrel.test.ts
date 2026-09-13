import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import {
  advanceHashChain,
  computeNextHash,
  initializeHashChain,
  validateHashChain,
} from '../../src/hash-chain/index.js';
import {
  advanceHashChain as advanceHashChainDirect,
  computeNextHash as computeNextHashDirect,
  initializeHashChain as initializeHashChainDirect,
  validateHashChain as validateHashChainDirect,
} from '../../src/hash-chain/chain.js';
import { DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH } from '../../src/compliance/index.js';

// The package exposes the hash chain through the `./hash-chain` subpath and
// the root barrel; both must re-export the same live implementations.
describe('hash-chain barrel re-exports', () => {
  test('re-exports the identical chain implementations', () => {
    expect(computeNextHash).toBe(computeNextHashDirect);
    expect(initializeHashChain).toBe(initializeHashChainDirect);
    expect(advanceHashChain).toBe(advanceHashChainDirect);
    expect(validateHashChain).toBe(validateHashChainDirect);
  });

  test('exported functions are callable and behave end-to-end', () => {
    const digest = computeNextHash('<canonical/>');

    expect(digest).toBe(crypto.createHash('sha256').update('<canonical/>', 'utf8').digest('base64'));

    const initial = initializeHashChain();
    expect(initial.lastHash).toBe(DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH);
    expect(initial.counter).toBe(0);

    const advanced = advanceHashChain(initial, digest, 'uuid-1');
    expect(advanced.counter).toBe(1);
    expect(advanced.lastHash).toBe(digest);
    expect(advanced.lastUuid).toBe('uuid-1');

    expect(
      validateHashChain([
        { hash: DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH, previousHash: DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH },
        { hash: digest, previousHash: DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH },
      ]).valid,
    ).toBe(true);
  });
});
