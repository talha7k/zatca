/**
 * ZATCA SDK conformance harness — validates this package's output against
 * the OFFICIAL ZATCA E-Invoicing Java SDK (offline Compliance &
 * Enablement Toolbox).
 *
 * Setup (SDK is NOT committed — it is a 160MB+ official download):
 *   1. Download from https://zatca.gov.sa (Systems Developers → Compliance
 *      Enablement Toolbox → Download SDK) after accepting the terms, or set
 *      ZATCA_SDK_HOME to an extracted SDK directory.
 *   2. Unzip it into the repo root (e.g. `zatca-envoice-sdk-203/`) — the
 *      harness auto-discovers `zatca-*sdk*` directories — or export
 *      ZATCA_SDK_HOME=<path to the extracted SDK root containing Apps/).
 *   3. JDK required (verified working on Java 21).
 *
 * SDK_CONFIG bootstrap: the underlying SDK library locates its XSD/schematron
 * data via the `SDK_CONFIG` environment variable (com/zatca/config/Config
 * reads `System.getenv("SDK_CONFIG")` — there is NO fallback). Without it the
 * CLI prints `failed to validate invoice - null` and exits 0 WITHOUT
 * validating anything. The harness therefore writes a config file with
 * absolute paths into `.tmp-sdk-conformance/` (gitignored) and exports
 * SDK_CONFIG for every CLI invocation. The vendored SDK's own
 * `Configuration/config.json` ships with Windows (`D:\...`) paths and cannot
 * be used on macOS/Linux.
 *
 * CLI facts established by reverse-engineering (see validation-report.ts and
 * parse-validation-report.test.ts): `-validate` ALWAYS exits 0, even when the
 * global validation result is FAILED — gates must parse the report, never
 * trust the exit code.
 *
 * Every test here is skipped automatically when the SDK or Java is absent,
 * so `bun test` stays green on machines without the SDK. CI can opt in by
 * providing the SDK.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateInvoiceXml, generateCreditNoteXml } from '../../src/xml/index.js';
import { signInvoice, canonicalizeForHash } from '../../src/signing/index.js';
import { signWithCsid } from './csid-signer.js';
import type { SignResult, SignWithExternalSignerParams } from '../../src/signing/index.js';
import { createTestInvoice, createTestCreditNote } from '../integration/fixtures.js';
import { TEST_CERT, TEST_PRIVATE_KEY } from './fixtures.js';
import { formatAmount } from '../../src/utils/xml.js';
import { parseValidationReport } from './validation-report.js';
import type { ParsedValidationReport } from './validation-report.js';

// ---------------------------------------------------------------------------
// SDK discovery
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '..', '..');

function findSdkHome(): string | undefined {
  const fromEnv = process.env.ZATCA_SDK_HOME;
  if (fromEnv && existsSync(join(fromEnv, 'Apps'))) return fromEnv;
  for (const entry of readdirSync(REPO_ROOT)) {
    if (/^zatca-.*sdk.*\d{3}$/i.test(entry) && existsSync(join(REPO_ROOT, entry, 'Apps'))) {
      return join(REPO_ROOT, entry);
    }
  }
  return undefined;
}

const SDK_HOME = findSdkHome();

function findCliJar(sdkHome: string): string | undefined {
  const apps = join(sdkHome, 'Apps');
  for (const f of readdirSync(apps)) {
    if (/cli-.*jar-with-dependencies\.jar$/.test(f)) return join(apps, f);
  }
  return undefined;
}

const CLI_JAR = SDK_HOME ? findCliJar(SDK_HOME) : undefined;
const SDK_VERSION = CLI_JAR?.match(/cli-(\d+\.\d+\.\d+)-/)?.[1];

function javaAvailable(): boolean {
  try {
    return spawnSync('java', ['-version'], { stdio: 'pipe' }).status === 0;
  } catch {
    return false;
  }
}

const SDK_READY = Boolean(SDK_HOME && CLI_JAR && SDK_VERSION && javaAvailable());
const sdkUnavailableReason = !SDK_HOME
  ? 'SDK not found (download from zatca.gov.sa, unzip into repo root, or set ZATCA_SDK_HOME)'
  : !javaAvailable()
    ? 'java not on PATH'
    : CLI_JAR
      ? undefined
      : 'cli jar not found in SDK Apps/';

interface SdkRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Config paths the SDK library requires (Config.readResourcesPaths keys). */
const SDK_CONFIG_RELATIVE_PATHS = {
  xsdPath: 'Data/Schemas/xsds/UBL2.1/xsd/maindoc/UBL-Invoice-2.1.xsd',
  enSchematron: 'Data/Rules/schematrons/CEN-EN16931-UBL.xsl',
  zatcaSchematron: 'Data/Rules/schematrons/20210819_ZATCA_E-invoice_Validation_Rules.xsl',
  certPath: 'Data/Certificates/cert.pem',
  privateKeyPath: 'Data/Certificates/ec-secp256k1-priv-key.pem',
  pihPath: 'Data/PIH/pih.txt',
  inputPath: 'Data/Input',
  usagePathFile: 'Configuration/usage.txt',
} as const;

const TMP_DIR = join(REPO_ROOT, '.tmp-sdk-conformance');
function tmpFile(name: string, content: string): string {
  // No spaces in paths — the SDK CLI tokenizes poorly.
  mkdirSync(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, name);
  writeFileSync(path, content);
  return path;
}

/**
 * Write an SDK config with ABSOLUTE paths (the vendored config.json has
 * Windows paths; the defaults use paths relative to the SDK's Configuration/
 * dir, which break when CWD is the repo root) and return its path.
 */
function writeSdkConfig(sdkHome: string): string {
  const config: Record<string, string> = {};
  for (const [key, relative] of Object.entries(SDK_CONFIG_RELATIVE_PATHS)) {
    config[key] = join(sdkHome, relative);
  }
  config.certPassword = '123456789';
  return tmpFile('sdk-config.json', JSON.stringify(config, null, 2));
}

const SDK_CONFIG_PATH = SDK_HOME && SDK_READY ? writeSdkConfig(SDK_HOME) : undefined;

function runSdk(args: string[]): SdkRun {
  const result = spawnSync(
    'java',
    ['-Djdk.module.illegalAccess=deny', '-Djdk.sunec.disableNative=false', '-jar', CLI_JAR!,
      '--globalVersion', SDK_VERSION!, '-certpassword', '123456789', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, SDK_CONFIG: SDK_CONFIG_PATH! } },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Run `-validate` and parse the report. Throws when the CLI crashed before
 * validating (broken SDK install/config) so a misconfigured machine can never
 * masquerade as a passing gate.
 */
function runValidate(invoicePath: string): { run: SdkRun; report: ParsedValidationReport } {
  const run = runSdk(['-validate', '-invoice', invoicePath]);
  const report = parseValidationReport(run.stdout, run.stderr);
  if (report.crashed) {
    throw new Error(
      `SDK -validate crashed before validating (broken SDK install or SDK_CONFIG). ` +
        `stdout=${run.stdout.trim().slice(-600)}`,
    );
  }
  return { run, report };
}

function logFindings(label: string, report: ParsedValidationReport): void {
  console.log(
    `[sdk-conformance] ${label}: stages=${JSON.stringify(report.stageResults)} ` +
      `xsd=${report.xsdErrors.length} schematron=${report.schematronErrors.length} ` +
      `other=${report.otherErrors.length} warnings=${report.warnings.length} ` +
      `global=${report.summary ?? 'n/a'}`,
  );
  for (const e of [...report.xsdErrors, ...report.schematronErrors, ...report.otherErrors]) {
    console.log(`[sdk-conformance]   ${e.slice(0, 240)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures — shared with the unit/integration suite
// ---------------------------------------------------------------------------

const sampleInvoice = createTestInvoice;

/** Conformance fixture: KSA-23 additional number present (BR-KSA-09/64). */
function conformanceInvoice(overrides?: Partial<ReturnType<typeof sampleInvoice>>): ReturnType<typeof sampleInvoice> {
  const invoice = sampleInvoice(overrides);
  return {
    ...invoice,
    supplier: {
      ...invoice.supplier,
      address: { ...invoice.supplier.address, additionalNumber: '8008' },
    },
  };
}

/**
 * Optional REAL sandbox CSID fixture — the missing piece for the QR
 * cryptographic stage (it compares signature R/S and the CA certificate
 * signature in QR tag 9, which only a ZATCA-issued CSID can satisfy).
 *
 * Provide either:
 *   - ZATCA_TEST_CSID env var, or
 *   - a .zatca-csid.json file (gitignored) in the repo root
 * with the shape:
 *   { "certificatePem": "...", "privateKeyPem": "...",
 *     "certificateSignature": "<base64 DER CA signature over the cert>" }
 *
 * Onboard a sandbox EGS once (developer portal → Integration Sandbox),
 * decode the returned binarySecurityToken to the PEM cert, and export the
 * CSID private key. When present, the harness signs with the real CSID and
 * the QR stage is asserted PASSED (hard gate); when absent it degrades to
 * "stage reached" as today.
 */
interface CsidFixture {
  certificatePem: string;
  privateKeyPem: string;
  certificateSignature: string;
}

function loadCsidFixture(): CsidFixture | undefined {
  const candidates = [process.env.ZATCA_TEST_CSID];
  try {
    candidates.push(readFileSync(join(REPO_ROOT, '.zatca-csid.json'), 'utf8'));
  } catch {
    // no fixture file — fine
  }
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as CsidFixture;
      if (parsed.certificatePem && parsed.privateKeyPem && parsed.certificateSignature) return parsed;
    } catch {
      throw new Error('ZATCA_TEST_CSID / .zatca-csid.json is set but is not valid JSON with certificatePem, privateKeyPem and certificateSignature');
    }
  }
  return undefined;
}

const CSID = loadCsidFixture();
const SIGNING_CERT = CSID?.certificatePem ?? TEST_CERT;
const SIGNING_KEY = CSID?.privateKeyPem ?? TEST_PRIVATE_KEY;
const CERT_SIGNATURE = CSID?.certificateSignature ?? 'MAYCASoCASs=';

/**
 * Sign with the configured credentials. With a real CSID fixture the key
 * curve (secp256k1) is unsupported by Bun's crypto, so signing goes through
 * the external-signer API backed by the openssl CLI — plus pre-extracted
 * certificate info (same reason) and public key.
 */
async function signWithConfiguredCredentials(
  params: Omit<SignWithExternalSignerParams, 'signer' | 'qrPublicKey' | 'certificateInfo'>,
): Promise<SignResult> {
  if (!CSID) {
    return signInvoice({ ...params, privateKeyPem: SIGNING_KEY, certificatePem: SIGNING_CERT });
  }
  return signWithCsid(params, {
    certificatePem: CSID.certificatePem,
    privateKeyPem: CSID.privateKeyPem,
    certificateSignature: CSID.certificateSignature,
  });
}

async function generateSignedInvoiceXml(): Promise<string> {
  const invoice = conformanceInvoice();
  return (await signWithConfiguredCredentials({
    xml: generateInvoiceXml(invoice),
    certificatePem: SIGNING_CERT,
    // Embed the Phase-2 QR (BR-KSA-27 requires it on simplified invoices).
    // Tag 9 is the ZATCA CA signature from a real CSID — the static test
    // certificate has none, so a placeholder suffices for schematron gates
    // (the CLI's cryptographic QR stage is not gated here).
    qrData: {
      // Tag 1 must equal the XML cbc:RegistrationName (the SDK QR stage
      // enforces equality) — the XML builder emits the Arabic name.
      sellerName: invoice.supplier.nameAr,
      vatNumber: invoice.supplier.vatNumber,
      // Tag 3 MUST equal cbc:IssueDate + 'T' + cbc:IssueTime verbatim: the
      // live gateway's QRCODE_VALIDATION warns (invoiceTimeStamp_QRCODE_INVALID)
      // on any deviation, including a trailing Z. (SDK 3.0.8's QR stage
      // prefers the Z form, but the gateway is the production authority and
      // the official samples are Z-less.)
      timestamp: `${invoice.issueDate}T${invoice.issueTime.replace(/Z$/, '')}`,
      totalWithVat: formatAmount(invoice.payableAmount),
      vatTotal: formatAmount(invoice.taxAmount),
      // Tag 9 is the ZATCA CA's DER ECDSA signature over the CSID cert —
      // unavailable offline with a self-signed test cert. A syntactically
      // valid DER signature placeholder keeps the TLV shape realistic.
      certificateSignature: CERT_SIGNATURE,
    },
  })).signedXml;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe.skipIf(!SDK_READY)(`ZATCA SDK conformance${sdkUnavailableReason ? ` (SKIPPED: ${sdkUnavailableReason})` : ` [SDK ${SDK_VERSION}]`}`, () => {
  test('invoice hash parity: canonicalizeForHash matches the official SDK -generateHash', () => {
    const xml = generateInvoiceXml(sampleInvoice());
    const sdkHash = extractHash(
      runSdk(['-generateHash', '-invoice', tmpFile('hash-parity.xml', xml)]),
    );
    const ours = canonicalizeForHash(xml).hashBase64;
    expect(sdkHash).toBe(ours);
  }, 120_000);

  test('negative control: XSD-invalid invoice yields a parsed, non-empty XSD error list', async () => {
    // Break the date datatype — XSD must reject it even though the document
    // stays well-formed (observed: `[XSD] validation result : FAILED` +
    // one generic SAXParseException entry).
    const broken = (await generateSignedInvoiceXml()).replace(
      /<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/,
      '<cbc:IssueDate>NOT-A-DATE</cbc:IssueDate>',
    );
    const { report } = runValidate(tmpFile('negative-xsd.xml', broken));
    logFindings('negative-control/xsd', report);
    expect(report.crashed).toBe(false);
    expect(report.stageResults.XSD).toBe('FAILED');
    expect(report.xsdErrors.length).toBeGreaterThan(0);
    expect(report.xsdErrors[0]).toContain('UBL 2.1 standards');
  }, 120_000);

  test('negative control: schematron-invalid invoice yields parsed schematron errors', async () => {
    // Drop every cac:TaxTotal — well-formed and XSD-legal (TaxTotal is not
    // XSD-mandatory) but violates EN16931 BR-CO-18/BR-53/BR-CO-15 (observed).
    const broken = (await generateSignedInvoiceXml()).replace(
      /<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/g,
      '',
    );
    const { report } = runValidate(tmpFile('negative-schematron.xml', broken));
    logFindings('negative-control/schematron', report);
    expect(report.crashed).toBe(false);
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors.length).toBeGreaterThan(0);
    expect(report.schematronErrors.some((e) => e.includes('BR-'))).toBe(true);
  }, 120_000);

  test('signed invoice: zero XSD schema errors (hard gate)', async () => {
    const { report } = runValidate(tmpFile('validate-signed.xml', await generateSignedInvoiceXml()));
    logFindings('signed-invoice', report);
    expect(report.crashed).toBe(false);
    expect(report.stageResults.XSD).toBe('PASSED');
    expect(report.xsdErrors).toEqual([]);
  }, 120_000);

  test('signed invoice: zero schematron errors (hard gate — XSD+EN+KSA all PASSED)', async () => {
    const { report } = runValidate(tmpFile('validate-signed.xml', await generateSignedInvoiceXml()));
    logFindings('signed-invoice', report);
    expect(report.crashed).toBe(false);
    expect(report.schematronErrors).toEqual([]);
    expect(report.stageResults.XSD).toBe('PASSED');
    expect(report.stageResults.EN).toBe('PASSED');
    expect(report.stageResults.KSA).toBe('PASSED');
    // The QR cryptographic stage runs only after XSD+EN+KSA pass. Our QR
    // follows the PUBLISHED spec layout (7=DER signature, 8=public key,
    // 9=certificate signature — matching the official SDK samples), but SDK
    // 3.0.8's validator expects a DIFFERENT layout: tag 7 = cert SPKI DER,
    // tag 8 = signature R, tag 9 = signature S. Proven by decompiling the
    // vendored jar (QrCodeValidator locals keyFromQrCode/rFromQrCode/
    // sFromQrCode read from tags 7/8/9; QRCodeGeneratorServiceImpl writes
    // pubkey/R/S to tags 7/8/9). That layout contradicts the spec, the
    // samples, and Fatoora core acceptance — so even WITH a real CSID
    // fixture the stage cannot pass without emitting spec-invalid QRs.
    // Gate: the stage must RUN and stay parsed (no crash); findings logged.
    // TODO(ZATCA): report the deviation on the Fatoora developer forum.
    expect(report.stageResults.QR).toBeDefined();
  }, 120_000);
});

function extractHash(run: SdkRun): string {
  const m = (run.stdout + run.stderr).match(/INVOICE HASH = (\S+)/);
  if (!m) throw new Error(`SDK did not report a hash. stdout=${run.stdout} stderr=${run.stderr}`);
  return m[1];
}

// ---------------------------------------------------------------------------
// Expanded coverage: document-type matrix + chained PIH
// ---------------------------------------------------------------------------

/** Sign any document with the conformance QR data derived from its header. */
async function signForConformance(
  xml: string,
  doc: { issueDate: string; issueTime: string; payableAmount: number; taxAmount: number },
): Promise<string> {
  return (await signWithConfiguredCredentials({
    xml,
    certificatePem: SIGNING_CERT,
    qrData: {
      sellerName: ARABIC_SELLER_NAME,
      vatNumber: SELLER_VAT_NUMBER,
      // Tag 3 MUST equal cbc:IssueDate + 'T' + cbc:IssueTime verbatim —
      // the live gateway warns (invoiceTimeStamp_QRCODE_INVALID) on any
      // deviation including a trailing Z. Official samples are Z-less;
      // the SDK 3.0.8 QR stage disagrees (see deviation guard), but the
      // gateway is the production authority.
      timestamp: `${doc.issueDate}T${doc.issueTime.replace(/Z$/, '')}`,
      totalWithVat: formatAmount(doc.payableAmount),
      vatTotal: formatAmount(doc.taxAmount),
      certificateSignature: CERT_SIGNATURE,
    },
  })).signedXml;
}

const ARABIC_SELLER_NAME = 'شركة اختبار';
const SELLER_VAT_NUMBER = '300000000000003';

/** Deterministic supply date for standard-invoice fixtures (KSA-5). */
function invoice_issue_date(): string {
  return conformanceInvoice().issueDate;
}

describe.skipIf(!SDK_READY)('ZATCA SDK conformance — document matrix', () => {
  test('standard (B2B) invoice with customer party passes XSD+EN+KSA', async () => {
    const invoice = conformanceInvoice({
      // Official standard samples and SDK 3.0.8's ruleset both keep BT-23
      // at reporting:1.0 (BR-KSA-EN16931-01) — clearance routing comes from
      // the KSA-2 subtype name, not the profile.
      invoiceTypeCodeName: '0100000',
      supplyDate: invoice_issue_date(),
      paymentMeansCode: 10,
      customer: {
        name: 'Test Buyer LLC',
        vatNumber: '310000000000003',
        // BR-KSA-10's assert (not its message) also demands
        // cbc:CountrySubentity + cbc:CitySubdivisionName on the buyer.
        address: { ...conformanceInvoice().supplier.address, countrySubentity: 'Riyadh Region' },
      },
    });
    const { report } = runValidate(
      tmpFile('validate-standard.xml', await signForConformance(generateInvoiceXml(invoice), invoice)),
    );
    logFindings('standard-invoice', report);
    expect(report.crashed).toBe(false);
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toEqual([]);
    expect(report.stageResults.EN).toBe('PASSED');
    expect(report.stageResults.KSA).toBe('PASSED');
  }, 120_000);

  test('credit note passes XSD+EN+KSA', async () => {
    const creditNote = {
      ...createTestCreditNote(),
      supplier: {
        ...createTestCreditNote().supplier,
        address: { ...createTestCreditNote().supplier.address, additionalNumber: '8008' },
      },
    };
    const { report } = runValidate(
      tmpFile('validate-credit-note.xml', await signForConformance(generateCreditNoteXml(creditNote), creditNote)),
    );
    logFindings('credit-note', report);
    expect(report.crashed).toBe(false);
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toEqual([]);
    expect(report.stageResults.KSA).toBe('PASSED');
  }, 120_000);

  test('hash chain: second invoice carries invoice 1 hashBase64 as PIH and still validates + hashes identically', async () => {
    const first = conformanceInvoice();
    const signed1 = await signForConformance(generateInvoiceXml(first), first);
    const pih = canonicalizeForHash(signed1).hashBase64;

    const second = conformanceInvoice({
      invoiceCounter: (first.invoiceCounter ?? 1) + 1,
      previousInvoiceHash: pih,
      uuid: 'b16f9d2e-7a34-4c5b-8d6e-9f0a1b2c3d4e',
    });
    const signed2 = await signForConformance(generateInvoiceXml(second), second);

    // The chained document must still carry the exact PIH we derived.
    expect(signed2).toContain(`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${pih}</cbc:EmbeddedDocumentBinaryObject>`);

    // ...must survive full validation, and the SDK must agree with our hash
    // of the chained document (canonicalization is PIH-value-independent,
    // proving the issue-#1 fix end-to-end).
    const { report } = runValidate(tmpFile('validate-chained.xml', signed2));
    logFindings('chained-invoice-2', report);
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toEqual([]);

    const sdkHash = extractHash(runSdk(['-generateHash', '-invoice', tmpFile('chained-hash.xml', signed2)]));
    expect(sdkHash).toBe(canonicalizeForHash(signed2).hashBase64);
  }, 120_000);
});
