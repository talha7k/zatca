/**
 * Credit Note XML Generation — UBL 2.1 for ZATCA Phase 2
 *
 * Generates ZATCA-compliant UBL 2.1 XML credit notes using template literals.
 * ZATCA SDK/Fatoora samples model credit notes in the invoice document flow:
 * - Root element: `Invoice`
 * - `cbc:InvoiceTypeCode` value `381`
 * - `cac:BillingReference` pointing to the original invoice
 * - `cac:PaymentMeans/cbc:InstructionNote` with the credit reason
 */

import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type { CreditNoteData } from '../types.js';
import { escapeXml } from '../utils/xml.js';
import {
  xmlAdditionalDocumentReferences,
  xmlAllowanceCharges,
  xmlCustomerParty,
  xmlInvoiceLine,
  xmlMonetaryTotal,
  xmlSignature,
  xmlSupplierParty,
  xmlTaxTotalBlocks,
  xmlUBLExtensions,
} from './fragments.js';

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
 * PaymentMeans block. ZATCA requires the reason for credit/debit notes in
 * cbc:InstructionNote, even when the same reason is also exposed as cbc:Note.
 */
function xmlPaymentMeans(creditNote: CreditNoteData): string {
  return `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${escapeXml(creditNote.reason)}</cbc:InstructionNote>
  </cac:PaymentMeans>`;
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
    .map((line) => xmlInvoiceLine(line, creditNote.currencyCode))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
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
  <cbc:InvoiceTypeCode name="${escapeXml(creditNote.invoiceTypeCodeName)}">${creditNote.invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:Note>${escapeXml(creditNote.reason)}</cbc:Note>
  <cbc:DocumentCurrencyCode>${escapeXml(creditNote.currencyCode)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${escapeXml(creditNote.currencyCode)}</cbc:TaxCurrencyCode>

${xmlBillingReference(creditNote)}

${additionalDocsBlock}${xmlSignature()}

${xmlSupplierParty(creditNote.supplier)}${customerBlock}

${xmlPaymentMeans(creditNote)}

${xmlAllowanceCharges(creditNote)}

${xmlTaxTotalBlocks(creditNote.taxAmount, creditNote.currencyCode, creditNote.taxSubtotals)}

${xmlMonetaryTotal(creditNote)}

${creditNoteLineBlocks}
</Invoice>`;
}
