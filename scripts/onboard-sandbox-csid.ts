#!/usr/bin/env bun
/**
 * Sandbox CSID onboarding for the OFFICIAL ZATCA Integration Sandbox.
 *
 * Automates the EGS onboarding sequence so the conformance harness can use
 * a REAL sandbox-issued CSID (required for the SDK's QR cryptographic stage):
 *
 *   1. generate an ECDSA P-256 key pair + CSR (ZATCA extensions)
 *   2. POST /compliance with the CSR (+ OTP header) → compliance CSID
 *   3. run the compliance-invoice checks (standard / simplified / credit /
 *      debit) against the sandbox
 *   4. POST /production/csids with the compliance request id → PCSID
 *      (sandbox-issued; safe for conformance, never production)
 *   5. persist the CSID material to `.zatca-csid.json` (gitignored) in the
 *      shape the conformance harness consumes
 *
 * THE OTP IS THE ONLY MANUAL STEP (verified against the official Fatoora
 * Portal User Manual + Developer Portal Manual, 2026-08 Qeemah walkthrough):
 *   1. Log in at https://fatoora.zatca.gov.sa with ERAD taxpayer credentials
 *      (TIN or registered ZATCA email — NOT Developer Portal credentials).
 *   2. Switch to the sandbox: click "FATOORA Portal Simulation" (top right).
 *      Production and Simulation are independent environments.
 *   3. Click "Onboard new solution unit/device", enter the OTP count
 *      (1–100 per batch), complete the reCAPTCHA, click "Generate OTP Code".
 *   4. Copy a 6-digit code (or export the file) and feed it to this script
 *      as --otp WITHIN 1 HOUR — OTPs expire after 60 minutes.
 *   VAT numbers in the Sandbox may be dummy values (15 digits, 3…3); every
 *   invoice/QR submitted with the resulting CSID must carry the SAME VAT.
 *
 * CSR profile note: this script generates the CSR with the environment-aware
 * template this library already implements (sandbox & production →
 * 'ZATCA-Code-Signing', simulation → 'PREZATCA-Code-Signing' per the OID
 * 1.3.6.1.4.1.311.20.2 certificateTemplateName convention).
 *
 *   bun scripts/onboard-sandbox-csid.ts --otp <OTP> --vat 310000000000003 [options]
 *
 *   Options:
 *     --otp <code>            OTP from the Fatoora portal (required for live mode)
 *     --vat <trn>             15-digit VAT number (required)
 *     --name-en/--name-ar     organization names (default: Sandbox Test Co / شركة الاختبار التجريبية)
 *     --common-name <cn>      EGS common name (default: TST-<vat>-SANDBOX01)
 *     --out <path>            output file (default: .zatca-csid.json in repo root)
 *     --portal sandbox|simulation (default: sandbox; selects the gateway base via apiConfig)
 *     --dry-run               generate the CSR + print every request payload
 *                             WITHOUT touching the network (default when --otp is absent)
 *     --show                  also print the CSID secrets to stdout (default: only paths/counters)
 *
 * Promise API only (no Effect) so the script runs anywhere the library does.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateCSR,
  extractCertificateSignature,
  ZatcaApiClient,
  buildComplianceInvoiceXml,
  signComplianceInvoice,
  type ZatcaApiConfig,
} from '../src/index.js';

const REPO_ROOT = join(import.meta.dir, '..');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const otp = flag('--otp');
const vat = flag('--vat');
const outPath = flag('--out') ?? join(REPO_ROOT, '.zatca-csid.json');
const portal = flag('--portal') ?? 'sandbox';
const dryRun = process.argv.includes('--dry-run') || !otp;
const show = process.argv.includes('--show');
const orgNameEn = flag('--name-en') ?? 'Sandbox Test Company';
const orgNameAr = flag('--name-ar') ?? 'شركة الاختبار التجريبية';

if (!vat || !/^\d{15}$/.test(vat)) {
  console.error('Usage: bun scripts/onboard-sandbox-csid.ts --vat <15-digit TRN> [--otp <code>] [--dry-run] [--show] [--out <path>] [--portal sandbox|simulation]');
  process.exit(1);
}

const baseUrl = portal === 'simulation'
  ? 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation-portal'
  : 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';

const apiConfig: ZatcaApiConfig = { environment: 'sandbox', sandboxUrl: baseUrl, timeout: 30_000, retryMax: 2 };
const client = new ZatcaApiClient(apiConfig);

// ---------------------------------------------------------------------------
// Step 1 — key pair + CSR
// ---------------------------------------------------------------------------

console.log('==> [1/4] generating ECDSA key pair + CSR (sandbox profile: prime256v1)');
// NOTE: the CSR embeds the public key of csrResult.privateKey — that same
// private key signs the compliance invoices in step 3 (not a separate one).
const csrResult = generateCSR({
  organizationNameAr: orgNameAr,
  organizationNameEn: orgNameEn,
  vatNumber: vat,
  crNumber: '1234567890',
  country: 'SA',
  commonName: flag('--common-name') ?? `TST-${vat}-SANDBOX01`,
  invoiceType: '0111001',
  location: {
    city: 'Riyadh', district: 'Al Olaya', street: 'King Fahd Road',
    buildingNumber: '1234', postalCode: '12211',
  },
  egsSerialNumber: `TST|SANDBOX|${vat}01`,
}, portal === 'simulation' ? 'simulation' : 'sandbox');
const { privateKey } = csrResult;
const csrBase64 = Buffer.from(csrResult.csr).toString('base64');
console.log(`    CSR: ${csrResult.csr.length} chars PEM (CN=${flag('--common-name') ?? `TST-${vat}-SANDBOX01`})`);

if (dryRun) {
  console.log('\n[DRY RUN] no network calls made. With an OTP the script would:');
  console.log(`  1. POST ${baseUrl}/compliance  {"csr": "<${csrBase64.length} chars>"}  + header OTP: <code>`);
  console.log('  2. sign one document per check type with the compliance CSID and POST /compliance/invoices');
  console.log('  3. POST /production/csids  {"compliance_request_id": "<id>"}');
  console.log(`  4. write ${outPath}  {certificatePem, privateKeyPem, certificateSignature}`);
  console.log('\nRe-run with --otp <code> from the Fatoora portal to go live.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 2 — compliance CSID (OTP)
// ---------------------------------------------------------------------------

console.log('==> [2/4] requesting compliance CSID (OTP auth)');
const compliance = await client.requestComplianceCSID(csrBase64, otp);
const complianceAccepted = compliance.status === 'ACCEPTED' || Boolean(compliance.binarySecurityToken);
if (!complianceAccepted) {
  console.error('Compliance CSID rejected. Full response:');
  console.error(JSON.stringify(compliance, null, 2).slice(0, 2000));
  process.exit(1);
}
const complianceCreds = { binarySecurityToken: compliance.binarySecurityToken, secret: compliance.secret };
console.log(`    compliance CSID accepted (requestId: ${compliance.requestId ?? 'n/a'})`);

// ---------------------------------------------------------------------------
// Step 3 — compliance invoice checks (one doc per type)
// ---------------------------------------------------------------------------

console.log('==> [3/4] running compliance-invoice checks');
const checkTypes = ['STANDARD_INVOICE', 'SIMPLIFIED_INVOICE', 'STANDARD_CREDIT_NOTE'] as const;
for (const checkType of checkTypes) {
  const built = buildComplianceInvoiceXml({
    checkType,
    supplier: complianceSupplier(),
    privateKeyPem: privateKey,
    certificatePem: decodeCert(compliance.binarySecurityToken),
  });
  const signed = signComplianceInvoice({
    checkType,
    supplier: complianceSupplier(),
    privateKeyPem: privateKey,
    certificatePem: decodeCert(compliance.binarySecurityToken),
  });
  void built;
  const res = await client.verifyCompliance(complianceCreds, signed.invoiceHash, signed.uuid, signed.base64SignedXml);
  console.log(`    ${checkType}: valid=${res.valid} messages=${res.messages.length}`);
  for (const m of res.messages) console.log(`      ${m.slice(0, 200)}`);
  if (!res.valid) {
    console.error('Compliance check failed — fix the document before requesting the production CSID.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 4 — production CSID (sandbox) + persist
// ---------------------------------------------------------------------------

console.log('==> [4/4] requesting production CSID (sandbox)');
const production = await client.requestProductionCSID(complianceCreds, compliance.requestId!);
if (!production.binarySecurityToken) {
  console.error('Production CSID rejected:', JSON.stringify(production).slice(0, 400));
  process.exit(1);
}
const certificatePem = decodeCert(production.binarySecurityToken);
const csid = {
  certificatePem,
  privateKeyPem: privateKey,
  certificateSignature: extractCertificateSignature(certificatePem),
};
writeFileSync(outPath, JSON.stringify(csid, null, 2));
console.log(`    wrote ${outPath} (certificate ${certificatePem.length} chars, key ${privateKey.length} chars)`);
if (show) console.log(JSON.stringify(csid, null, 2));
else console.log('    secrets NOT printed (pass --show to display). Re-run the conformance suite to exercise the QR crypto gate.');

// ---------------------------------------------------------------------------

function decodeCert(binarySecurityToken: string): string {
  const der = Buffer.from(binarySecurityToken, 'base64').toString('utf8');
  if (der.includes('BEGIN CERTIFICATE')) return der;
  // Some responses wrap the PEM in JSON — extract the first PEM block.
  const m = der.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!m) throw new Error('compliance/production response did not contain a PEM certificate');
  return m[0];
}

function complianceSupplier() {
  return {
    nameAr: orgNameAr,
    nameEn: orgNameEn,
    vatNumber: vat!,
    address: {
      street: 'King Fahd Road', building: '1234', additionalNumber: '8008',
      district: 'Al Olaya', city: 'Riyadh', postalCode: '12211', countryCode: 'SA',
    },
  };
}
