import { describe, expect, test } from 'bun:test';
import { decodeTokenToPem } from '../../src/certificate/index.js';
import { ZatcaError } from '../../src/index.js';
import { TEST_CERT } from '../conformance/fixtures.js';

describe('decodeTokenToPem (binarySecurityToken shapes)', () => {
  test('passes a verbatim PEM block through', () => {
    expect(decodeTokenToPem(TEST_CERT)).toBe(TEST_CERT);
  });

  test('extracts a PEM block embedded in a larger string', () => {
    const wrapped = `prefix-noise${TEST_CERT}suffix-noise`;
    expect(decodeTokenToPem(wrapped)).toBe(TEST_CERT);
  });

  test('decodes single-encoded base64 DER to PEM', () => {
    const der = Buffer.from(
      TEST_CERT.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''),
      'base64',
    );
    const token = der.toString('base64');
    const pem = decodeTokenToPem(token);
    expect(pem).toContain('-----BEGIN CERTIFICATE-----');
    expect(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')).toBe(token);
  });

  test('decodes double-encoded base64 DER (production-portal shape)', () => {
    const der = Buffer.from(
      TEST_CERT.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''),
      'base64',
    );
    const doubleEncoded = Buffer.from(der.toString('base64')).toString('base64');
    const pem = decodeTokenToPem(doubleEncoded);
    expect(pem).toContain('-----BEGIN CERTIFICATE-----');
    expect(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')).toBe(der.toString('base64'));
  });

  test('rejects empty and garbage input with ZatcaError', () => {
    expect(() => decodeTokenToPem('')).toThrow(ZatcaError);
    expect(() => decodeTokenToPem('   ')).toThrow(ZatcaError);
    expect(() => decodeTokenToPem('not-a-cert!!!')).toThrow(ZatcaError);
  });
});
