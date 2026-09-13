import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateCSR } from '../../src/certificate/index.js';
import type { CSRParams } from '../../src/types.js';

const PARAMS: CSRParams = {
  organizationNameAr: 'شركة الاختبار',
  organizationNameEn: 'Test Company',
  vatNumber: '300000000000003',
  crNumber: '1234567890',
  country: 'SA',
  commonName: 'CONFTEST01',
  invoiceType: '1100',
  location: {
    city: 'Riyadh', district: 'Al Olaya', street: 'King Fahd Road',
    buildingNumber: '1234', postalCode: '12211',
  },
  egsSerialNumber: 'TST|SANDBOX|30000000000000301',
};

function openssl(args: string[], input?: string): string {
  return execFileSync('openssl', args, input !== undefined ? { input } : {}).toString();
}

describe('generateCSR output structure (openssl-verified)', () => {
  test('sandbox profile emits a parseable P-256 CSR with the VAT in the SAN', () => {
    const { csr, privateKey, publicKey } = generateCSR(PARAMS, 'sandbox');
    expect(csr).toContain('-----BEGIN CERTIFICATE REQUEST-----');
    const text = openssl(['req', '-in', '/dev/stdin', '-noout', '-text'], csr);
    expect(text).toContain('Public Key Algorithm: id-ecPublicKey');
    expect(text).toContain('NIST CURVE: P-256');
    expect(text).toContain('300000000000003'); // VAT in SAN UID
    expect(text).toContain('CN=TST-CONFTEST01-300000000000003');
    // The CSR's public key matches the returned key pair.
    const csrPub = openssl(['req', '-in', '/dev/stdin', '-noout', '-pubkey'], csr);
    expect(csrPub.replace(/\s/g, '')).toBe(publicKey.replace(/\s/g, ''));
    expect(privateKey).toContain('PRIVATE KEY');
  });

  test('the CSR carries a valid self-signature (proof of possession)', () => {
    const { csr } = generateCSR(PARAMS, 'sandbox');
    const out = openssl(['req', '-in', '/dev/stdin', '-noout', '-verify'], csr);
    expect(out).toMatch(/verify (OK|ok)/i);
  });

  test('certificate template extension matches the environment profile', () => {
    const sandbox = openssl(['req', '-in', '/dev/stdin', '-noout', '-text'], generateCSR(PARAMS, 'sandbox').csr);
    const simulation = openssl(['req', '-in', '/dev/stdin', '-noout', '-text'], generateCSR(PARAMS, 'simulation').csr);
    expect(sandbox).toContain('ZATCA-Code-Signing');
    expect(simulation).toContain('PREZATCA-Code-Signing');
  });

  test('EGS serial and title land in the SAN dirName block', () => {
    const text = openssl(['req', '-in', '/dev/stdin', '-noout', '-text'], generateCSR(PARAMS, 'sandbox').csr);
    expect(text).toContain('TST|SANDBOX|30000000000000301');
    expect(text).toMatch(/title=1100|1100/);
  });
});
