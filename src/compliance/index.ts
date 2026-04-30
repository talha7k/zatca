import type { CustomerInfo, SupplierInfo } from '../types.js';
import { generateInvoiceXml } from '../xml/index.js';
import { signInvoice } from '../signing/sign.js';
import { extractCertificateSignature } from '../certificate/generate.js';

export type ZatcaComplianceCheckType =
  | 'SIMPLIFIED_INVOICE'
  | 'SIMPLIFIED_CREDIT_NOTE'
  | 'SIMPLIFIED_DEBIT_NOTE'
  | 'STANDARD_INVOICE'
  | 'STANDARD_CREDIT_NOTE'
  | 'STANDARD_DEBIT_NOTE';

export interface BuildComplianceInvoiceXmlInput {
  checkType: ZatcaComplianceCheckType;
  supplier: SupplierInfo;
  customer?: CustomerInfo;
  uuid?: string;
  invoiceNumber?: string;
  issueDate?: string;
  issueTime?: string;
  currencyCode?: string;
  invoiceCounter?: number;
  previousInvoiceHash?: string;
  originalInvoiceNumber?: string;
  originalInvoiceUuid?: string;
  originalInvoiceDate?: string;
}

export interface BuildComplianceInvoiceXmlResult {
  checkType: ZatcaComplianceCheckType;
  invoiceXml: string;
  uuid: string | null;
}

export interface SignComplianceInvoiceInput extends BuildComplianceInvoiceXmlInput {
  privateKeyPem: string;
  certificatePem: string;
}

export interface SignComplianceInvoiceResult {
  checkType: ZatcaComplianceCheckType;
  invoiceXml: string;
  signedXml: string;
  invoiceHash: string;
  uuid: string;
  base64SignedXml: string;
}

export const DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

export function normalizeArabicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function digitsOnly(value: string): string {
  return normalizeArabicDigits(value).replace(/\D/g, '');
}

export function normalizeZatcaBuildingNumber(value: string): string {
  const digits = digitsOnly(value);
  return digits ? digits.padStart(4, '0').slice(-4) : value;
}

export function normalizeZatcaPostalCode(value: string): string {
  const digits = digitsOnly(value);
  return digits ? digits.padStart(5, '0').slice(-5) : value;
}

export function asCertificatePem(certificate: string): string {
  const trimmed = certificate.trim();
  if (trimmed.includes('BEGIN CERTIFICATE')) {
    return trimmed;
  }
  const compact = trimmed.replace(/\s+/g, '');
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    if (decoded.includes('BEGIN CERTIFICATE')) {
      return decoded;
    }
    const decodedCompact = decoded.trim().replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(decodedCompact)) {
      const nestedDer = Buffer.from(decodedCompact, 'base64');
      if (nestedDer[0] === 0x30) {
        const wrappedNested = decodedCompact.match(/.{1,64}/g)?.join('\n');
        return `-----BEGIN CERTIFICATE-----\n${wrappedNested ?? decodedCompact}\n-----END CERTIFICATE-----`;
      }
    }
  } catch {
    // Fall through and treat the input as base64 DER.
  }
  const wrapped = compact.match(/.{1,64}/g)?.join('\n');
  return `-----BEGIN CERTIFICATE-----\n${wrapped ?? compact}\n-----END CERTIFICATE-----`;
}

export function extractXmlValue(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<cbc:${tagName}(?:\\s[^>]*)?>([^<]+)<\\/cbc:${tagName}>`));
  return match?.[1] ?? null;
}

export function extractInvoiceUuid(xml: string): string | null {
  return extractXmlValue(xml, 'UUID');
}

export function extractInvoiceTimestamp(xml: string): string {
  const issueDate = extractXmlValue(xml, 'IssueDate');
  const issueTime = extractXmlValue(xml, 'IssueTime');
  const fallback = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  if (!issueDate || !issueTime) return fallback;
  return `${issueDate}T${issueTime.replace(/Z$/, '')}`;
}

function extractCertificateSignatureOrEmpty(certificatePem: string): string {
  try {
    return extractCertificateSignature(certificatePem);
  } catch (error) {
    console.warn(
      '[ZATCA compliance] Could not extract certificate signature for QR tag 9; continuing with placeholder tag.',
      error instanceof Error ? error.message : error,
    );
    return 'AA==';
  }
}

function normalizeSupplier(supplier: SupplierInfo): SupplierInfo {
  return {
    ...supplier,
    address: {
      ...supplier.address,
      building: normalizeZatcaBuildingNumber(supplier.address.building),
      postalCode: normalizeZatcaPostalCode(supplier.address.postalCode),
    },
  };
}

function patchAdditionalDocumentReferences(xml: string): string {
  return xml.replace(
    /<cac:AdditionalDocumentReference>\s*<cbc:ID>PIH<\/cbc:ID>\s*<cbc:DocumentDescription>([^<]+)<\/cbc:DocumentDescription>\s*<\/cac:AdditionalDocumentReference>/g,
    `<cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">$1</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>`,
  );
}

function patchSignatureReference(xml: string): string {
  return xml;
}

function patchCreditDebitInvoice(
  xml: string,
  input: BuildComplianceInvoiceXmlInput,
  isCredit: boolean,
  isDebit: boolean,
): string {
  if (!isCredit && !isDebit) {
    return xml;
  }

  const reason = isCredit ? 'Compliance test credit note' : 'Compliance test debit note';
  const originalInvoiceNumber =
    input.originalInvoiceNumber ??
    (input.checkType.startsWith('STANDARD') ? 'COMP-TI-001' : 'COMP-SI-001');
  const originalInvoiceUuid = input.originalInvoiceUuid ?? crypto.randomUUID();
  const originalInvoiceDate =
    input.originalInvoiceDate ?? input.issueDate ?? new Date().toISOString().slice(0, 10);

  const billingReference = `  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${originalInvoiceNumber}</cbc:ID>
      <cbc:UUID>${originalInvoiceUuid}</cbc:UUID>
      <cbc:IssueDate>${originalInvoiceDate}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`;

  const paymentMeans = `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${reason}</cbc:InstructionNote>
  </cac:PaymentMeans>`;

  let patched = xml.replace(
    /(<cbc:InvoiceTypeCode[^>]*>[^<]+<\/cbc:InvoiceTypeCode>)/,
    `$1\n  <cbc:Note>${reason}</cbc:Note>`,
  );
  patched = patched.replace(
    /(<cac:AdditionalDocumentReference>[\s\S]*?<cbc:ID>ICV<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>)/,
    `${billingReference}\n\n$1`,
  );
  patched = patched.replace(/(<cac:TaxTotal>)/, `${paymentMeans}\n\n$1`);
  return patched;
}

export function buildComplianceInvoiceXml(input: BuildComplianceInvoiceXmlInput): BuildComplianceInvoiceXmlResult {
  const isStandard = input.checkType.startsWith('STANDARD');
  const isCredit = input.checkType.endsWith('CREDIT_NOTE');
  const isDebit = input.checkType.endsWith('DEBIT_NOTE');

  const invoiceNumber =
    input.invoiceNumber ??
    (isStandard
      ? isCredit
        ? 'COMP-TCN-001'
        : isDebit
          ? 'COMP-TDN-001'
          : 'COMP-TI-001'
      : isCredit
        ? 'COMP-SCN-001'
        : isDebit
          ? 'COMP-SDN-001'
          : 'COMP-SI-001');

  const invoiceTypeCode = isCredit ? '381' : isDebit ? '383' : '388';
  const invoiceTypeCodeName = isStandard ? '0100000' : '0200000';
  const now = new Date();

  const xml = patchCreditDebitInvoice(
    patchSignatureReference(
      patchAdditionalDocumentReferences(
        generateInvoiceXml({
          invoiceNumber,
          uuid: input.uuid ?? crypto.randomUUID(),
          issueDate: input.issueDate ?? now.toISOString().slice(0, 10),
          issueTime: input.issueTime ?? now.toISOString().slice(11, 19),
          invoiceTypeCode,
          invoiceTypeCodeName,
          profileId: isStandard ? 'clearance:1.0' : 'reporting:1.0',
          currencyCode: input.currencyCode ?? 'SAR',
          invoiceCounter: input.invoiceCounter,
          previousInvoiceHash: input.previousInvoiceHash ?? DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH,
          supplier: normalizeSupplier(input.supplier),
          customer: isStandard ? input.customer ?? defaultComplianceCustomer() : input.customer,
          lineExtensionAmount: 100,
          taxExclusiveAmount: 100,
          taxInclusiveAmount: 115,
          payableAmount: 115,
          taxAmount: 15,
          taxSubtotals: [
            {
              taxableAmount: 100,
              taxAmount: 15,
              percent: 15,
              taxCategoryId: 'S',
            },
          ],
          invoiceLines: [
            {
              id: 1,
              quantity: 1,
              unitCode: 'C62',
              lineExtensionAmount: 100,
              taxAmount: 15,
              itemName: isCredit
                ? 'Compliance Credit Item'
                : isDebit
                  ? 'Compliance Debit Item'
                  : 'Compliance Test Item',
              taxCategoryId: 'S',
              taxPercent: 15,
              priceAmount: 100,
            },
          ],
        }),
      ),
    ),
    input,
    isCredit,
    isDebit,
  );

  return {
    checkType: input.checkType,
    invoiceXml: xml,
    uuid: extractInvoiceUuid(xml),
  };
}

export function signComplianceInvoice(input: SignComplianceInvoiceInput): SignComplianceInvoiceResult {
  const built = buildComplianceInvoiceXml(input);
  const certificatePem = asCertificatePem(input.certificatePem);

  const signed = signInvoice({
    xml: built.invoiceXml,
    privateKeyPem: input.privateKeyPem,
    certificatePem,
    qrData: {
      sellerName: input.supplier.nameAr,
      vatNumber: input.supplier.vatNumber,
      timestamp: extractInvoiceTimestamp(built.invoiceXml),
      totalWithVat: extractXmlValue(built.invoiceXml, 'TaxInclusiveAmount') ?? '115.00',
      vatTotal: extractXmlValue(built.invoiceXml, 'TaxAmount') ?? '15.00',
      certificateSignature: extractCertificateSignatureOrEmpty(certificatePem),
    },
  });

  const uuid = built.uuid ?? input.uuid;
  if (!uuid) {
    throw new Error('Compliance invoice XML is missing cbc:UUID');
  }

  return {
    checkType: input.checkType,
    invoiceXml: built.invoiceXml,
    signedXml: signed.signedXml,
    invoiceHash: signed.invoiceHash,
    uuid,
    base64SignedXml: Buffer.from(signed.signedXml).toString('base64'),
  };
}

function defaultComplianceCustomer(): CustomerInfo {
  return {
    name: 'Compliance Test Customer',
    vatNumber: '300000000000003',
    address: {
      street: 'Test Street',
      building: '1234',
      district: 'Test District',
      city: 'Riyadh',
      postalCode: '12211',
      countryCode: 'SA',
    },
  };
}
