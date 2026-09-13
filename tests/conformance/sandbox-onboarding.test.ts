/**
 * LIVE sandbox onboarding test — exercises the real CSID issuance path
 * (compliance CSID → production CSID) against the official ZATCA
 * developer-portal gateway using the documented sandbox OTP.
 *
 * Opt-in ONLY: set ZATCA_SANDBOX_ONBOARDING=1. The test hits the live
 * sandbox (network), needs the openssl CLI (secp256k1 CSR), and issues a
 * throwaway sandbox CSID per run. Never runs in default `bun test`.
 *
 * What it proves: the library's own onboarding sequence (ZatcaApiClient +
 * CSR + decodeTokenToPem + extractCertificateSignature) completes against
 * the real gateway — the same code path scripts/onboard-sandbox-csid.ts
 * drives.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ZatcaApiClient,
  decodeTokenToPem,
  extractCertificateSignature,
} from '../../src/index.js';

const OPT_IN = process.env.ZATCA_SANDBOX_ONBOARDING === '1';
const SANDBOX_URL = 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';
// Sandbox OTP reference: the developer-portal sandbox gateway accepts the
// well-known dummy OTP `12345` (documented in ZATCA's own forum examples,
// e.g. the `-H "OTP: 12345"` curl for .../developer-portal/compliance).
// Override with ZATCA_SANDBOX_OTP for a portal-issued OTP if it ever rotates.
const SANDBOX_OTP = process.env.ZATCA_SANDBOX_OTP ?? '12345';

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    execFileSync('openssl', ['ecparam', '-list_curves'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const reason = !OPT_IN
  ? 'opt-in only (set ZATCA_SANDBOX_ONBOARDING=1)'
  : !opensslAvailable()
    ? 'openssl CLI unavailable'
    : undefined;

const CSR_CONFIG = (cn: string) => `oid_section = OIDs

[OIDs]
certificateTemplateName = 1.3.6.1.4.1.311.20.2

[req]
prompt = no
distinguished_name = dn
req_extensions = v3_req
emailAddress = placeholder@email.com

[dn]
C = SA
O = Conformance Test Co
OU = Test Branch
CN = ${cn}

[v3_req]
certificateTemplateName = ASN1:PRINTABLESTRING:PREZATCA-Code-Signing
subjectAltName = dirName:alt_names
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment

[alt_names]
SN = 1-ConformanceTest|2-Harness|3-EGSCONF000000001
UID = 310000000000003
title = 1100
registeredAddress = Riyadh
businessCategory = Retail
`;

describe.skipIf(reason !== undefined)(`sandbox CSID issuance (live gateway)${reason ? ` — SKIPPED: ${reason}` : ''}`, () => {
  test('compliance CSID → production CSID end-to-end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csid-issuance-'));
    try {
      // secp256k1 key + canonical ZATCA CSR profile via openssl.
      execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', join(dir, 'key.pem')], { stdio: 'pipe' });
      writeFileSync(join(dir, 'csr.cnf'), CSR_CONFIG('TST-310000000000003-CONF01'));
      execFileSync('openssl', ['req', '-new', '-sha256', '-key', join(dir, 'key.pem'), '-config', join(dir, 'csr.cnf'), '-out', join(dir, 'csr.pem')], { stdio: 'pipe' });
      const { readFileSync } = await import('node:fs');
      const csrPem = readFileSync(join(dir, 'csr.pem'), 'utf8');
      expect(csrPem).toContain('BEGIN CERTIFICATE REQUEST');

      const client = new ZatcaApiClient({
        environment: 'sandbox',
        sandboxUrl: SANDBOX_URL,
        timeout: 60_000,
        retryMax: 2,
      });
      // requestComplianceCSID base64-encodes the PEM itself — pass it raw.
      void 0;

      // Step 1: compliance CSID (OTP header).
      const compliance = await client.requestComplianceCSID(csrPem, SANDBOX_OTP);
      expect(compliance.status).toBe('ACCEPTED');
      expect(compliance.binarySecurityToken.length).toBeGreaterThan(100);
      expect(compliance.secret.length).toBeGreaterThan(0);
      expect(compliance.requestId).toBeTruthy();

      // Step 2: production CSID (sandbox skips compliance checks).
      const production = await client.requestProductionCSID(
        { binarySecurityToken: compliance.binarySecurityToken, secret: compliance.secret },
        String(compliance.requestId),
      );
      expect(production.binarySecurityToken.length).toBeGreaterThan(100);
      expect(production.secret.length).toBeGreaterThan(0);

      // Step 3: the issued token decodes to a real CA-signed certificate
      // whose signature extracts cleanly (QR tag 9 material).
      const pem = decodeTokenToPem(production.binarySecurityToken);
      expect(pem).toContain('-----BEGIN CERTIFICATE-----');
      const certSig = extractCertificateSignature(pem);
      expect(certSig.length).toBeGreaterThan(0);
      // Throws if the PEM is not parseable X.509.
      new (await import('node:crypto')).X509Certificate(pem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
