/**
 * Invoice XML Generation — UBL 2.1 for ZATCA Phase 2
 *
 * Generates ZATCA-compliant UBL 2.1 XML invoices using template literals.
 * Template literals give full control over element order, multiple same-named
 * siblings, and attribute+text content — things js2xmlparser handles poorly.
 *
 * Differences from legacy xml-generator.ts:
 * - `cbc:UBLVersionID` = "2.1" (explicit, required by ZATCA)
 * - `cac:AdditionalDocumentReference` for ICV (invoice counter) and PIH (previous hash)
 * - `cac:Signature` element (required by ZATCA)
 * - `cbc:RoundingAmount` in each invoice line's `cac:TaxTotal`
 * - `cac:PartyIdentification` with `schemeID="CR"` for supplier
 * - Second `cac:TaxTotal` with tax currency (ZATCA requires both)
 */

import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type { InvoiceData } from '../types.js';
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
 * Generate a complete ZATCA-compliant UBL 2.1 invoice XML string.
 */
export function generateInvoiceXml(invoice: InvoiceData): string {
  try {
    return buildInvoiceXml(invoice);
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to generate invoice XML: ${(error as Error).message}`,
      ZatcaErrorCode.XML_GEN_ERROR,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Assemble the complete invoice XML document.
 */
function buildInvoiceXml(invoice: InvoiceData): string {
  const additionalDocs = xmlAdditionalDocumentReferences(invoice);
  const additionalDocsBlock = additionalDocs
    ? `\n${additionalDocs}\n`
    : '\n';

  // Note: Using empty AccountingCustomerParty for simplified (B2C) invoices.
  // ZATCA requires this element even for simplified invoices where no customer details exist.
  const customerBlock = invoice.customer
    ? `\n${xmlCustomerParty(invoice.customer)}`
    : `\n  <cac:AccountingCustomerParty>\n  </cac:AccountingCustomerParty>`;

  const invoiceLineBlocks = invoice.invoiceLines
    .map((line) => xmlInvoiceLine(line, invoice.currencyCode))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
${xmlUBLExtensions()}
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ProfileID>${escapeXml(invoice.profileId)}</cbc:ProfileID>
  <cbc:ID>${escapeXml(invoice.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${escapeXml(invoice.uuid)}</cbc:UUID>
  <cbc:IssueDate>${escapeXml(invoice.issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${escapeXml(invoice.issueTime)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${escapeXml(invoice.invoiceTypeCodeName)}">${invoice.invoiceTypeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${escapeXml(invoice.currencyCode)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${escapeXml(invoice.currencyCode)}</cbc:TaxCurrencyCode>
${additionalDocsBlock}${xmlSignature()}

${xmlSupplierParty(invoice.supplier)}${customerBlock}

${xmlAllowanceCharges(invoice)}

${xmlTaxTotalBlocks(invoice.taxAmount, invoice.currencyCode, invoice.taxSubtotals)}

${xmlMonetaryTotal(invoice)}

${invoiceLineBlocks}
</Invoice>`;
}
