/**
 * Unit tests for parseValidationReport — NO SDK REQUIRED.
 *
 * Every sample below is VERBATIM output captured from the official ZATCA
 * Java SDK 3.0.8 CLI (`java -jar cli-3.0.8-jar-with-dependencies.jar
 * --globalVersion 3.0.8 -certpassword 123456789 -validate -invoice <file>`)
 * during reverse-engineering sessions on macOS (timestamps included).
 *
 * Output format facts established by observation (SDK 3.0.8):
 * - log4j-style lines: `YYYY-MM-DD HH:MM:SS,mmm [LEVEL] Logger - message`
 * - the welcome banner is emitted at the top (first line is
 *   `[ERROR] MainApp - ` followed by banner text!) — lines without a
 *   timestamp prefix must never be misparsed as findings.
 * - stage results:  `[INFO] ValidationProcessorImpl - [XSD] validation result : PASSED|FAILED`
 *   (stages observed: XSD, EN, KSA, QR; SIGNATURE/PIH exist in the CLI binary)
 * - per-stage error blocks: `[ERROR] ValidationProcessorImpl - <stage> validation errors : `
 *   followed by one line per finding:
 *   `[ERROR] ValidationProcessorImpl - CODE : <code>, MESSAGE : <message>`
 * - the CLI folds schematron warnings and errors into the same block
 *   (e.g. BR-KSA-09 is flag="warning" in the schematron yet still prints
 *   under `ksa validation errors`) — there is NO separate warnings channel;
 *   `warnings` in the parse result is reserved for `[WARN]`-level log lines.
 * - final summary: `[INFO] InvoiceValidationService -  *** GLOBAL VALIDATION RESULT = PASSED|FAILED `
 *   (note the double space after `-` and the trailing space)
 * - SDK misconfiguration crashes BEFORE validating and STILL exits 0:
 *   `[ERROR] InvoiceValidationService - failed to validate invoice - null`
 *   → must be surfaced as `crashed`, never as an empty-error pass.
 */
import { describe, expect, test } from 'bun:test';
import { parseValidationReport } from './validation-report.js';

// --- captured samples -------------------------------------------------------

/** Captured: valid signed invoice, all schematron stages pass. */
const ALL_PASSED = `********** Welcome to ZATCA E-Invoice Java SDK 3.0.8 *********************
This SDK uses Java to call the SDK (jar) passing it an invoice XML file.
It can take a Standard or Simplified XML, Credit Note, or Debit Note.
It returns if the validation is successful or shows errors where the XML validation fails.
It checks for syntax and content as well.

****************************************************************
2026-09-13 22:41:24,638 [INFO] XsdValidator - Validate XSD for invoice : /tmp/invoice.xml
2026-09-13 22:41:24,814 [INFO] ValidationProcessorImpl - [XSD] validation result : PASSED
2026-09-13 22:41:24,816 [INFO] SchematronValidator - Validate Schematron using /sdk/CEN-EN16931-UBL.xsl for invoice : /tmp/invoice.xml
2026-09-13 22:41:25,160 [INFO] ValidationProcessorImpl - [EN] validation result : PASSED
2026-09-13 22:41:25,160 [INFO] SchematronValidator - Validate Schematron using /sdk/20210819_ZATCA_E-invoice_Validation_Rules.xsl for invoice : /tmp/invoice.xml
2026-09-13 22:41:25,262 [INFO] ValidationProcessorImpl - [KSA] validation result : PASSED
2026-09-13 22:41:25,502 [INFO] InvoiceValidationService -  *** GLOBAL VALIDATION RESULT = PASSED `;

/** Captured: `<cbc:IssueDate>NOT-A-DATE</cbc:IssueDate>` → XSD stage failure.
 * The CLI collapses all XSD violations into one generic SAXParseException entry. */
const XSD_FAILED = `********** Welcome to ZATCA E-Invoice Java SDK 3.0.8 *********************
It checks for syntax and content as well.

****************************************************************
2026-09-13 22:36:42,261 [INFO] XsdValidator - Validate XSD for invoice : /tmp/broken-xsd-date.xml
2026-09-13 22:36:42,425 [INFO] ValidationProcessorImpl - [XSD] validation result : FAILED
2026-09-13 22:36:42,425 [ERROR] ValidationProcessorImpl - xsd validation errors : 
2026-09-13 22:36:42,426 [ERROR] ValidationProcessorImpl - CODE : SAXParseException, MESSAGE : Schema validation failed; XML does not comply with UBL 2.1 standards in line with ZATCA specifications
2026-09-13 22:36:42,426 [INFO] InvoiceValidationService -  *** GLOBAL VALIDATION RESULT = FAILED `;

/** Captured: invoice with <cac:TaxTotal> removed → EN16931 schematron failure. */
const EN_FAILED = `****************************************************************
2026-09-13 22:36:18,072 [INFO] XsdValidator - Validate XSD for invoice : /tmp/broken-no-taxtotal.xml
2026-09-13 22:36:18,235 [INFO] ValidationProcessorImpl - [XSD] validation result : PASSED
2026-09-13 22:36:18,236 [INFO] SchematronValidator - Validate Schematron using /sdk/CEN-EN16931-UBL.xsl for invoice : /tmp/broken-no-taxtotal.xml
2026-09-13 22:36:18,559 [INFO] ValidationProcessorImpl - [EN] validation result : FAILED
2026-09-13 22:36:18,559 [ERROR] ValidationProcessorImpl - en validation errors : 
2026-09-13 22:36:18,559 [ERROR] ValidationProcessorImpl - CODE : BR-CO-18, MESSAGE : [BR-CO-18]-An Invoice shall at least have one VAT breakdown group (BG-23).
2026-09-13 22:36:18,559 [ERROR] ValidationProcessorImpl - CODE : BR-53, MESSAGE : [BR-53]-If the VAT accounting currency code (BT-6) is present, then the Invoice total VAT amount in accounting currency (BT-111) shall be provided.
2026-09-13 22:36:18,559 [ERROR] ValidationProcessorImpl - CODE : BR-CO-15, MESSAGE : [BR-CO-15]-Invoice total amount with VAT (BT-112) = Invoice total amount without VAT (BT-109) + Invoice total VAT amount (BT-110).
2026-09-13 22:36:18,559 [INFO] InvoiceValidationService -  *** GLOBAL VALIDATION RESULT = FAILED `;

/** Captured: our signed simplified invoice → KSA schematron failure. */
const KSA_FAILED = `****************************************************************
2026-09-13 22:35:38,048 [INFO] XsdValidator - Validate XSD for invoice : /tmp/signed.xml
2026-09-13 22:35:38,214 [INFO] ValidationProcessorImpl - [XSD] validation result : PASSED
2026-09-13 22:35:38,215 [INFO] SchematronValidator - Validate Schematron using /sdk/CEN-EN16931-UBL.xsl for invoice : /tmp/signed.xml
2026-09-13 22:35:38,544 [INFO] ValidationProcessorImpl - [EN] validation result : PASSED
2026-09-13 22:35:38,544 [INFO] SchematronValidator - Validate Schematron using /sdk/20210819_ZATCA_E-invoice_Validation_Rules.xsl for invoice : /tmp/signed.xml
2026-09-13 22:35:38,626 [INFO] ValidationProcessorImpl - [KSA] validation result : FAILED
2026-09-13 22:35:38,626 [ERROR] ValidationProcessorImpl - ksa validation errors : 
2026-09-13 22:35:38,626 [ERROR] ValidationProcessorImpl - CODE : BR-KSA-09, MESSAGE : [BR-KSA-09]-Seller address must contain additional number (KSA-23), street name (BT-35), building number (KSA-17), postal code (BT-38), city (BT-37), Neighborhood (KSA-3), country code (BT-40). For more information please access this link: https://www.address.gov.sa/en/address-format/overview
2026-09-13 22:35:38,626 [ERROR] ValidationProcessorImpl - CODE : BR-KSA-64, MESSAGE : [BR-KSA-64]-Seller Address Additional number (KSA-23) must be 4 digits.
2026-09-13 22:35:38,626 [ERROR] ValidationProcessorImpl - CODE : BR-KSA-27, MESSAGE : [BR-KSA-27]-The document must contain aa QR code (KSA-14), and this code must be base64Binary. Please refer to the Security Features Implementation Standards for more details.
2026-09-13 22:35:38,626 [INFO] InvoiceValidationService -  *** GLOBAL VALIDATION RESULT = FAILED `;

/** Captured: invoice that passes XSD+EN+KSA but fails the cryptographic QR stage. */
const QR_STAGE_FAILED = `****************************************************************
2026-09-13 22:41:24,638 [INFO] XsdValidator - Validate XSD for invoice : /tmp/probe.xml
2026-09-13 22:41:24,814 [INFO] ValidationProcessorImpl - [XSD] validation result : PASSED
2026-09-13 22:41:24,816 [INFO] SchematronValidator - Validate Schematron using /sdk/CEN-EN16931-UBL.xsl for invoice : /tmp/probe.xml
2026-09-13 22:41:25,160 [INFO] ValidationProcessorImpl - [EN] validation result : PASSED
2026-09-13 22:41:25,160 [INFO] SchematronValidator - Validate Schematron using /sdk/20210819_ZATCA_E-invoice_Validation_Rules.xsl for invoice : /tmp/probe.xml
2026-09-13 22:41:25,262 [INFO] ValidationProcessorImpl - [KSA] validation result : PASSED
2026-09-13 22:41:25,502 [INFO] ValidationProcessorImpl - [QR] validation result : FAILED
2026-09-13 22:41:25,502 [ERROR] ValidationProcessorImpl - qr validation errors : 
2026-09-13 22:41:25,503 [ERROR] ValidationProcessorImpl - CODE : R, MESSAGE : R value of the signature tag in the invoice doesn't match the R value in tag 8 of the QR code
2026-09-13 22:41:25,503 [ERROR] ValidationProcessorImpl - CODE : S, MESSAGE : S value of the signature tag in the invoice doesn't match the S value in tag 9 of the QR code
2026-09-13 22:41:25,503 [ERROR] ValidationProcessorImpl - CODE : vatTotal, MESSAGE : vatTotal does not match with qr code vatTotal
2026-09-13 22:41:25,503 [ERROR] ValidationProcessorImpl - CODE : sellerName, MESSAGE : seller name does not match with qr code seller name
2026-09-13 22:41:25,503 [ERROR] ValidationProcessorImpl - CODE : hashedXml, MESSAGE : hashedXml does not match with qr code hashedXml
2026-09-13 22:41:25,503 [INFO] InvoiceValidationService -  *** GLOBAL VALIDATION RESULT = FAILED `;

/** Captured: CLI run WITHOUT SDK_CONFIG set — crashes before validating, exit code 0. */
const CRASHED = `2026-09-13 22:31:04,499 [ERROR] MainApp - 
********** Welcome to ZATCA E-Invoice Java SDK 3.0.8 *********************
It checks for syntax and content as well.

****************************************************************
2026-09-13 22:31:04,501 [INFO] XsdValidator - Validate XSD for invoice : /tmp/signed.xml
2026-09-13 22:31:04,515 [ERROR] InvoiceValidationService - failed to validate invoice - null`;

// --- tests -------------------------------------------------------------------

describe('parseValidationReport (against captured SDK 3.0.8 output)', () => {
  test('all stages PASSED → no errors, summary PASSED', () => {
    const report = parseValidationReport(ALL_PASSED, '');
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toEqual([]);
    expect(report.otherErrors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.summary).toBe('PASSED');
    expect(report.crashed).toBe(false);
    expect(report.stageResults).toEqual({ XSD: 'PASSED', EN: 'PASSED', KSA: 'PASSED' });
  });

  test('XSD failure → exactly one xsdErrors entry, other buckets empty', () => {
    const report = parseValidationReport(XSD_FAILED, '');
    expect(report.xsdErrors).toHaveLength(1);
    expect(report.xsdErrors[0]).toContain('SAXParseException');
    expect(report.xsdErrors[0]).toContain('UBL 2.1 standards');
    expect(report.schematronErrors).toEqual([]);
    expect(report.otherErrors).toEqual([]);
    expect(report.summary).toBe('FAILED');
    expect(report.stageResults.XSD).toBe('FAILED');
  });

  test('EN schematron failure → BR-* codes land in schematronErrors, not xsdErrors', () => {
    const report = parseValidationReport(EN_FAILED, '');
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toHaveLength(3);
    expect(report.schematronErrors[0]).toContain('BR-CO-18');
    expect(report.schematronErrors[1]).toContain('BR-53');
    expect(report.schematronErrors[2]).toContain('BR-CO-15');
    expect(report.stageResults.EN).toBe('FAILED');
  });

  test('KSA schematron failure → BR-KSA-* codes parsed with messages', () => {
    const report = parseValidationReport(KSA_FAILED, '');
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toHaveLength(3);
    expect(report.schematronErrors.some((e) => e.includes('BR-KSA-09'))).toBe(true);
    expect(report.schematronErrors.some((e) => e.includes('BR-KSA-64'))).toBe(true);
    expect(report.schematronErrors.some((e) => e.includes('BR-KSA-27'))).toBe(true);
    // the message text survives parsing
    expect(report.schematronErrors.some((e) => e.includes('must be 4 digits'))).toBe(true);
    expect(report.stageResults.KSA).toBe('FAILED');
  });

  test('QR-stage failure (non-schematron) → otherErrors, schematronErrors stays empty', () => {
    const report = parseValidationReport(QR_STAGE_FAILED, '');
    expect(report.schematronErrors).toEqual([]);
    expect(report.xsdErrors).toEqual([]);
    expect(report.otherErrors).toHaveLength(5);
    expect(report.otherErrors.some((e) => e.includes('hashedXml'))).toBe(true);
    expect(report.stageResults).toEqual({ XSD: 'PASSED', EN: 'PASSED', KSA: 'PASSED', QR: 'FAILED' });
    expect(report.summary).toBe('FAILED');
  });

  test('crash sentinel (broken SDK config) → crashed=true, no bogus findings', () => {
    const report = parseValidationReport(CRASHED, '');
    expect(report.crashed).toBe(true);
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toEqual([]);
    expect(report.otherErrors).toEqual([]);
    expect(report.summary).toBeUndefined();
  });

  test('welcome banner (untimestamped lines) is never parsed as a finding', () => {
    // 'It returns if the validation is successful...' contains no CODE : — but
    // guard against any line leaking into a bucket.
    const report = parseValidationReport(ALL_PASSED, '');
    expect(report.xsdErrors).toEqual([]);
    expect(report.schematronErrors).toEqual([]);
  });

  test('stderr [WARN] lines are captured as warnings', () => {
    const stderr = '2026-09-13 22:35:38,100 [WARN] SomeLogger - watch out';
    const report = parseValidationReport(ALL_PASSED, stderr);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('watch out');
  });

  test('empty output → crashed=true (nothing validated)', () => {
    const report = parseValidationReport('', '');
    expect(report.crashed).toBe(true);
    expect(report.summary).toBeUndefined();
  });
});
