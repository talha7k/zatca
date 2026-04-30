/**
 * Credit Note XML Generation — UBL 2.1 for ZATCA Phase 2
 *
 * Generates ZATCA-compliant UBL 2.1 XML credit notes using template literals.
 * Credit notes share most of the invoice structure but differ in:
 * - Root element: `CreditNote` instead of `Invoice`
 * - `cbc:CreditNoteTypeCode` instead of `cbc:InvoiceTypeCode`
 * - `cac:BillingReference` pointing to the original invoice
 * - `cbc:Note` with the credit reason
 * - `cac:CreditNoteLine` instead of `cac:InvoiceLine`
 * - `cbc:CreditedQuantity` instead of `cbc:InvoicedQuantity`
 */

import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type {
  CreditNoteData,
  SupplierInfo,
  CustomerInfo,
  PostalAddress,
  TaxSubtotal,
  InvoiceLineItem,
} from '../types.js';
import { escapeXml, formatAmount } from '../utils/xml.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a complete ZATCA-compliant UBL 2.1 credit note XML string.
 */
export function generateCreditNoteXml(creditNote: CreditNoteData): string {
  try {
    return buildCreditNoteXml(creditNote);
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to generate credit note XML: ${(error as Error).message}`,
      ZatcaErrorCode.XML_GEN_ERROR,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// XML fragment generators
// ---------------------------------------------------------------------------

/**
 * BillingReference block pointing to the original invoice.
 */
function xmlBillingReference(creditNote: CreditNoteData): string {
  return `  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${escapeXml(creditNote.originalInvoiceNumber)}</cbc:ID>
      <cbc:UUID>${escapeXml(creditNote.originalInvoiceUuid)}</cbc:UUID>
      <cbc:IssueDate>${escapeXml(creditNote.originalInvoiceDate)}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`;
}

/**
 * Empty UBLExtensions block — placeholder for signature and QR.
 */
function xmlUBLExtensions(): string {
  return `  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>`;
}

/**
 * AdditionalDocumentReference elements for ICV and PIH.
 */
function xmlAdditionalDocumentReferences(creditNote: CreditNoteData): string {
  const refs: string[] = [];

  if (creditNote.invoiceCounter !== undefined) {
    refs.push(`  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${escapeXml(String(creditNote.invoiceCounter))}</cbc:UUID>
  </cac:AdditionalDocumentReference>`);
  }

  if (creditNote.previousInvoiceHash) {
    refs.push(`  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cbc:DocumentDescription>${escapeXml(creditNote.previousInvoiceHash)}</cbc:DocumentDescription>
  </cac:AdditionalDocumentReference>`);
  }

  return refs.join('\n');
}

/**
 * Signature element (required by ZATCA).
 */
function xmlSignature(): string {
  return `  <cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
  </cac:Signature>`;
}

/**
 * Postal address block.
 */
function xmlPostalAddress(addr: PostalAddress, indent: string): string {
  return `${indent}<cac:PostalAddress>
${indent}  <cbc:StreetName>${escapeXml(addr.street)}</cbc:StreetName>
${indent}  <cbc:AdditionalStreetName>${escapeXml(addr.building)}</cbc:AdditionalStreetName>
${indent}  <cbc:CitySubdivisionName>${escapeXml(addr.district)}</cbc:CitySubdivisionName>
${indent}  <cbc:CityName>${escapeXml(addr.city)}</cbc:CityName>
${indent}  <cbc:PostalZone>${escapeXml(addr.postalCode)}</cbc:PostalZone>
${indent}  <cac:Country>
${indent}    <cbc:IdentificationCode>${escapeXml(addr.countryCode)}</cbc:IdentificationCode>
${indent}  </cac:Country>
${indent}</cac:PostalAddress>`;
}

/**
 * AccountingSupplierParty block with both Arabic and English names,
 * PartyIdentification with schemeID="CRN", and PartyLegalEntity.
 */
function xmlSupplierParty(supplier: SupplierInfo): string {
  const crBlock = supplier.crNumber
    ? `\n      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${escapeXml(supplier.crNumber)}</cbc:ID>
      </cac:PartyIdentification>`
    : '';

  return `  <cac:AccountingSupplierParty>
    <cac:Party>
${crBlock}
      <cbc:RegistrationName>${escapeXml(supplier.nameAr)}</cbc:RegistrationName>
${xmlPostalAddress(supplier.address, '      ')}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(supplier.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(supplier.nameEn)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>`;
}

/**
 * AccountingCustomerParty block (B2B credit notes).
 */
function xmlCustomerParty(customer: CustomerInfo): string {
  const addressBlock = customer.address
    ? `\n${xmlPostalAddress(customer.address, '      ')}`
    : '';

  return `  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:RegistrationName>${escapeXml(customer.name)}</cbc:RegistrationName>${addressBlock}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(customer.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingCustomerParty>`;
}

/**
 * Tax total blocks — ZATCA requires TWO TaxTotal elements:
 * 1. With TaxSubtotals breakdown
 * 2. With TaxCurrencyCode (same tax amount, different context)
 */
function xmlTaxTotalBlocks(
  taxAmount: number,
  currencyCode: string,
  subtotals: TaxSubtotal[],
): string {
  const subtotalBlocks = subtotals.map((s) => xmlTaxSubtotal(s, currencyCode)).join('\n');

  // First TaxTotal with breakdown
  const withSubtotals = `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(taxAmount)}</cbc:TaxAmount>
${subtotalBlocks}
  </cac:TaxTotal>`;

  // Second TaxTotal with tax currency (ZATCA requirement)
  const withTaxCurrency = `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(taxAmount)}</cbc:TaxAmount>
  </cac:TaxTotal>`;

  return `${withSubtotals}\n${withTaxCurrency}`;
}

/**
 * Single tax subtotal block.
 */
function xmlTaxSubtotal(subtotal: TaxSubtotal, currencyCode: string): string {
  return `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(subtotal.taxableAmount)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(subtotal.taxAmount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${subtotal.taxCategoryId}</cbc:ID>
        <cbc:Percent>${formatAmount(subtotal.percent)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
}

/**
 * Legal monetary total block.
 */
function xmlMonetaryTotal(creditNote: CreditNoteData): string {
  const allowanceBlock = creditNote.allowanceTotalAmount
    ? `\n    <cbc:AllowanceTotalAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.allowanceTotalAmount)}</cbc:AllowanceTotalAmount>`
    : '';

  return `  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.lineExtensionAmount)}</cbc:LineExtensionAmount>${allowanceBlock}
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.taxExclusiveAmount)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.taxInclusiveAmount)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.payableAmount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`;
}

/**
 * Single credit note line block with TaxTotal including RoundingAmount.
 * Uses `cbc:CreditedQuantity` instead of `cbc:InvoicedQuantity`.
 */
function xmlCreditNoteLine(line: InvoiceLineItem, currencyCode: string): string {
  return `  <cac:CreditNoteLine>
    <cbc:ID>${line.id}</cbc:ID>
    <cbc:CreditedQuantity unitCode="${escapeXml(line.unitCode)}">${formatAmount(line.quantity)}</cbc:CreditedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(line.lineExtensionAmount)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(line.taxAmount)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(line.lineExtensionAmount + line.taxAmount)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${escapeXml(line.itemName)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${line.taxCategoryId}</cbc:ID>
        <cbc:Percent>${formatAmount(line.taxPercent)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(line.priceAmount)}</cbc:PriceAmount>
    </cac:Price>
  </cac:CreditNoteLine>`;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Assemble the complete credit note XML document.
 */
function buildCreditNoteXml(creditNote: CreditNoteData): string {
  const additionalDocs = xmlAdditionalDocumentReferences(creditNote);
  const additionalDocsBlock = additionalDocs
    ? `\n${additionalDocs}\n`
    : '\n';

  const customerBlock = creditNote.customer
    ? `\n${xmlCustomerParty(creditNote.customer)}`
    : '';

  const creditNoteLineBlocks = creditNote.invoiceLines
    .map((line) => xmlCreditNoteLine(line, creditNote.currencyCode))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
            xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
            xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
            xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
${xmlUBLExtensions()}
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ProfileID>${escapeXml(creditNote.profileId)}</cbc:ProfileID>
  <cbc:ID>${escapeXml(creditNote.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${escapeXml(creditNote.uuid)}</cbc:UUID>
  <cbc:IssueDate>${escapeXml(creditNote.issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${escapeXml(creditNote.issueTime)}</cbc:IssueTime>
  <cbc:CreditNoteTypeCode name="${escapeXml(creditNote.invoiceTypeCodeName)}">${creditNote.invoiceTypeCode}</cbc:CreditNoteTypeCode>
  <cbc:Note>${escapeXml(creditNote.reason)}</cbc:Note>
  <cbc:DocumentCurrencyCode>${escapeXml(creditNote.currencyCode)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${escapeXml(creditNote.currencyCode)}</cbc:TaxCurrencyCode>
${additionalDocsBlock}${xmlSignature()}

${xmlBillingReference(creditNote)}

${xmlSupplierParty(creditNote.supplier)}${customerBlock}

${xmlTaxTotalBlocks(creditNote.taxAmount, creditNote.currencyCode, creditNote.taxSubtotals)}

${xmlMonetaryTotal(creditNote)}

${creditNoteLineBlocks}
</CreditNote>`;
}
