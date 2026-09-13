import { describe, expect, test } from 'bun:test';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  extractPublicKey,
  extractRawPublicKey,
  generateECDSAKeyPair,
  isCertificateExpired,
  isCertificateExpiringSoon,
  parseCertificate,
} from '../../src/certificate/index.js';
import { ZatcaError } from '../../src/index.js';

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBdzCCAR2gAwIBAgIUaumRZCMc9o3ZxLuAISSXffuresEwCgYIKoZIzj0EAwIw
ETEPMA0GA1UEAwwGdGVzdGNhMB4XDTI2MDUwMTExMjg1NloXDTI3MDUwMTExMjg1
NlowETEPMA0GA1UEAwwGdGVzdGNhMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
z3vRHcXK1dgFsLqXdbNzSETiEIuC6rFmpmN697nECxPtRDR5vNC2GhPoO6rtwp4+
BttdIhIWo8HSMSYGsfiipKNTMFEwHQYDVR0OBBYEFDpE5pXNp2qWghXpkJavkHIb
uDU+MB8GA1UdIwQYMBaAFDpE5pXNp2qWghXpkJavkHIbuDU+MA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAP2Okl6ZMxD8xABvIDDUBycGcZNqUl0o
pBLnzUm2S9AiAiBLlAutK/rCJOb6EkHHaMYHgQREBZdiLhlf6NR1WMYGBA==
-----END CERTIFICATE-----`;

const MASTER_KEY = 'a'.repeat(64);

describe('parseCertificate', () => {
  test('extracts subject, issuer, serial and validity window', () => {
    const info = parseCertificate(TEST_CERT);
    expect(info.subject).toContain('CN=testca');
    expect(info.issuer).toContain('CN=testca');
    expect(info.serialNumber).toMatch(/^[0-9a-f]+$/i);
    expect(typeof info.validFrom).toBe('string');
    expect(typeof info.validTo).toBe('string');
    expect(new Date(info.validTo).getTime()).toBeGreaterThan(new Date(info.validFrom).getTime());
  });

  test('flags expiry state and days-until-expiry consistently', () => {
    const info = parseCertificate(TEST_CERT);
    expect(info.isExpired).toBe(false);
    expect(info.daysUntilExpiry).toBeGreaterThan(0);
  });

  test('throws a ZatcaError for malformed PEM input', () => {
    expect(() => parseCertificate('not a pem')).toThrow(ZatcaError);
  });
});

describe('isCertificateExpired / isCertificateExpiringSoon', () => {
  test('valid long-lived cert: not expired, not expiring soon at default 30 days', () => {
    expect(isCertificateExpired(TEST_CERT)).toBe(false);
    expect(isCertificateExpiringSoon(TEST_CERT)).toBe(false);
  });

  test('expiring-soon window is inclusive of the remaining lifetime', () => {
    // The test cert has ~8 months left; a 10000-day window must flag it.
    expect(isCertificateExpiringSoon(TEST_CERT, 10_000)).toBe(true);
  });

  test('expired cert reports expired=true and expiringSoon=false', async () => {
    const expired = await makeCertificate('-365d', '-1d');
    if (expired === undefined) return; // openssl absent — skipped
    expect(isCertificateExpired(expired)).toBe(true);
    expect(isCertificateExpiringSoon(expired)).toBe(false);
  });
});

describe('extractPublicKey / extractRawPublicKey', () => {
  test('extractPublicKey returns a PEM SubjectPublicKeyInfo', () => {
    const pem = extractPublicKey(TEST_CERT);
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
  });

  test('extractRawPublicKey returns the base64 raw EC point (65 bytes, 0x04 prefix)', () => {
    const b64 = extractRawPublicKey(TEST_CERT);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+={1,2}$/);
    const bytes = Buffer.from(b64, 'base64');
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04); // uncompressed EC point
  });

  test('extractRawPublicKey accepts a public key PEM directly', () => {
    const pem = extractPublicKey(TEST_CERT);
    const fromKey = extractRawPublicKey(pem);
    expect(fromKey).toBe(extractRawPublicKey(TEST_CERT));
  });
});

describe('generateECDSAKeyPair', () => {
  test('returns a usable PEM key pair', async () => {
    const { generateKeyPairSync, createPrivateKey, createPublicKey } = await import('node:crypto');
    const pair = generateECDSAKeyPair();
    // Must parse with node crypto and round-trip the public half.
    const priv = createPrivateKey(pair.privateKey);
    const pub = createPublicKey(pair.publicKey);
    expect(pub.export({ type: 'spki', format: 'pem' })).toContain('PUBLIC KEY');
    expect(priv.asymmetricKeyType).toBe('ec');
  });
});

describe('encryptPrivateKey / decryptPrivateKey (AES-256-GCM)', () => {
  test('round-trips a private key PEM', () => {
    const { privateKey } = generateECDSAKeyPair();
    const sealed = encryptPrivateKey(privateKey, MASTER_KEY);
    expect(sealed).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decryptPrivateKey(sealed, MASTER_KEY)).toBe(privateKey);
  });

  test('produces a distinct ciphertext per call (random IV)', () => {
    const { privateKey } = generateECDSAKeyPair();
    expect(encryptPrivateKey(privateKey, MASTER_KEY)).not.toBe(encryptPrivateKey(privateKey, MASTER_KEY));
  });

  test('tampered auth tag fails decryption', () => {
    const { privateKey } = generateECDSAKeyPair();
    const [iv, , data] = encryptPrivateKey(privateKey, MASTER_KEY).split(':');
    const tampered = `${iv}:${'0'.repeat(32)}:${data}`;
    expect(() => decryptPrivateKey(tampered, MASTER_KEY)).toThrow();
  });

  test('wrong master key fails decryption', () => {
    const { privateKey } = generateECDSAKeyPair();
    const sealed = encryptPrivateKey(privateKey, MASTER_KEY);
    expect(() => decryptPrivateKey(sealed, 'b'.repeat(64))).toThrow();
  });

  test('rejects missing key material and malformed master keys / formats', () => {
    expect(() => encryptPrivateKey('', MASTER_KEY)).toThrow(ZatcaError);
    expect(() => encryptPrivateKey('x', 'nothex')).toThrow(ZatcaError);
    expect(() => decryptPrivateKey('garbage', MASTER_KEY)).toThrow(ZatcaError);
  });
});

/** Best-effort self-signed cert with a custom validity window (openssl). */
async function makeCertificate(notBefore: string, notAfter: string): Promise<string | undefined> {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, rmSync } = await import('node:fs');
  const tmp = `/tmp/zatca-cert-${Date.now()}`;
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${tmp}.key`], { stdio: 'pipe' });
    execFileSync('openssl', [
      'req', '-new', '-x509', '-key', `${tmp}.key`, '-subj', '/CN=expired-test',
      '-not_before', notBefore, '-not_after', notAfter, '-days', '1', '-out', `${tmp}.crt`,
    ], { stdio: 'pipe' });
    const cert = readFileSync(`${tmp}.crt`).toString();
    return cert.includes('BEGIN CERTIFICATE') ? cert : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(`${tmp}.key`, { force: true });
    rmSync(`${tmp}.crt`, { force: true });
  }
}
