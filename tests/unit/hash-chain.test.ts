/**
 * Unit tests for the ZATCA invoice hash chain (GitHub issue #1).
 *
 * Pins the corrected semantics:
 * - Chain formula: Base64(SHA-256(canonicalized invoice XML)) — the PIH is
 *   carried inside the document, never folded into the preimage, and the
 *   digest is base64 (not hex).
 * - The first invoice's PIH must be the BR-KSA-26 genesis constant
 *   (base64 of the UTF-8 hex string of sha256("0") — 88 chars).
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import {
  advanceHashChain,
  computeNextHash,
  initializeHashChain,
  validateHashChain,
} from '../../src/hash-chain/chain.js';
import { DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH } from '../../src/compliance/index.js';
import { ZatcaError, ZatcaErrorCode } from '../../src/errors.js';

const GENESIS = DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH;

const SAMPLE_XML = '<Invoice><ID>TEST-1</ID></Invoice>';
// Hardcoded pin, independently precomputed:
//   crypto.createHash('sha256').update(SAMPLE_XML, 'utf8').digest('base64')
const SAMPLE_EXPECTED = 'r7+FNinbmVhpbjBuC/3aeewjDC5igF3/Y/gQrJ3zNhY=';

describe('computeNextHash (issue #1)', () => {
  test('returns base64 SHA-256 of the canonical XML alone', () => {
    const hash = computeNextHash(SAMPLE_XML);

    expect(hash).toBe(SAMPLE_EXPECTED);
    expect(hash.length).toBe(44);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test('matches crypto.createHash(...).digest("base64") for a sample', () => {
    const expected = crypto
      .createHash('sha256')
      .update(SAMPLE_XML, 'utf8')
      .digest('base64');

    expect(computeNextHash(SAMPLE_XML)).toBe(expected);
  });

  test('is independent of previousHash — PIH is carried in the document, never hashed', () => {
    const withEmpty = computeNextHash(SAMPLE_XML, '');
    const withGenesis = computeNextHash(SAMPLE_XML, GENESIS);
    const withForeign = computeNextHash(SAMPLE_XML, 'AAAAforeignhashAAAAforeignhashAAAA=');
    const baseline = computeNextHash(SAMPLE_XML);

    expect(withEmpty).toBe(baseline);
    expect(withGenesis).toBe(baseline);
    expect(withForeign).toBe(baseline);
  });

  test('accepts the deprecated previousHash argument without changing output', () => {
    // Back-compat: callers still pass the previous invoice hash positionally;
    // it must be ignored, not folded into the preimage.
    expect(computeNextHash(SAMPLE_XML, GENESIS)).toBe(computeNextHash(SAMPLE_XML));
  });

  test('throws ZatcaError HASH_CHAIN_ERROR for empty canonicalXml', () => {
    let caught: unknown;
    try {
      computeNextHash('');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ZatcaError);
    expect((caught as ZatcaError).code).toBe(ZatcaErrorCode.HASH_CHAIN_ERROR);
  });
});

describe('initializeHashChain (issue #1)', () => {
  test('seeds lastHash with the BR-KSA-26 genesis PIH', () => {
    const state = initializeHashChain();

    expect(state.lastHash).toBe(GENESIS);
  });

  test('genesis constant is base64 of the UTF-8 hex string of sha256("0") (88 chars)', () => {
    // Self-verifies the constant's provenance so a typo in either the
    // compliance constant or this expectation is caught.
    const expected = Buffer.from(
      crypto.createHash('sha256').update('0', 'utf8').digest('hex'),
      'utf8',
    ).toString('base64');

    expect(GENESIS).toBe(expected);
    expect(GENESIS.length).toBe(88);
  });

  test('starts the counter at 0 with no last UUID', () => {
    const state = initializeHashChain();

    expect(state.counter).toBe(0);
    expect(state.lastUuid).toBe('');
    expect(typeof state.updatedAt).toBe('string');
  });
});

describe('advanceHashChain', () => {
  test('stores the new hash/UUID and increments the counter', () => {
    const initial = initializeHashChain();
    const next = advanceHashChain(initial, 'hash-1', 'uuid-1');

    expect(next.lastHash).toBe('hash-1');
    expect(next.lastUuid).toBe('uuid-1');
    expect(next.counter).toBe(initial.counter + 1);
    expect(next.counter).toBe(1);
    expect(typeof next.updatedAt).toBe('string');
  });

  test('advances again from an advanced state (counter 2)', () => {
    const initial = initializeHashChain();
    const first = advanceHashChain(initial, 'hash-1', 'uuid-1');
    const second = advanceHashChain(first, 'hash-2', 'uuid-2');

    expect(second.lastHash).toBe('hash-2');
    expect(second.lastUuid).toBe('uuid-2');
    expect(second.counter).toBe(2);
  });

  test('throws ZatcaError HASH_CHAIN_ERROR for empty newHash or newUuid', () => {
    const initial = initializeHashChain();

    expect(() => advanceHashChain(initial, '', 'uuid-1')).toThrow(ZatcaError);
    expect(() => advanceHashChain(initial, 'hash-1', '')).toThrow(ZatcaError);
  });
});

describe('validateHashChain (issue #1) · first-invoice genesis rules', () => {
  test('accepts a first invoice carrying the genesis PIH', () => {
    const result = validateHashChain([
      { hash: computeNextHash(SAMPLE_XML), previousHash: GENESIS },
    ]);

    expect(result.valid).toBe(true);
  });

  test('rejects a first invoice with an empty previousHash', () => {
    const result = validateHashChain([
      { hash: computeNextHash(SAMPLE_XML), previousHash: '' },
    ]);

    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
    expect(result.message).toMatch(/genesis|BR-KSA-26/i);
  });

  test('rejects a first invoice with a foreign hash', () => {
    const result = validateHashChain([
      {
        hash: computeNextHash(SAMPLE_XML),
        previousHash: 'AAAAforeignhashAAAAforeignhashAAAA=',
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
    expect(result.message).toMatch(/genesis|BR-KSA-26/i);
  });
});

describe('validateHashChain (issue #1) · linked chains', () => {
  test('validates a chain of N invoices linked by previousHash === prior hash', () => {
    const xmls = [
      '<Invoice><ID>INV-1</ID></Invoice>',
      '<Invoice><ID>INV-2</ID></Invoice>',
      '<Invoice><ID>INV-3</ID></Invoice>',
    ];
    const invoices: Array<{ hash: string; previousHash: string }> = [];
    for (const xml of xmls) {
      invoices.push({
        hash: computeNextHash(xml),
        previousHash: invoices.length === 0 ? GENESIS : invoices[invoices.length - 1].hash,
      });
    }

    const result = validateHashChain(invoices);

    expect(result.valid).toBe(true);
  });

  test('reports a broken mid-chain link', () => {
    const invoices = [
      { hash: computeNextHash('<Invoice><ID>INV-1</ID></Invoice>'), previousHash: GENESIS },
      { hash: computeNextHash('<Invoice><ID>INV-2</ID></Invoice>'), previousHash: GENESIS },
    ];

    const result = validateHashChain(invoices);

    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
  });

  test('treats an empty list as valid', () => {
    const result = validateHashChain([]);

    expect(result.valid).toBe(true);
  });
});
