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
import type {
  InvoiceData,
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
// XML fragment generators
// ---------------------------------------------------------------------------

/**
 * Empty UBLExtensions block — placeholder for signature and QR.
 * The signing module will inject the actual content before submission.
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
function xmlAdditionalDocumentReferences(invoice: InvoiceData): string {
  const refs: string[] = [];

  if (invoice.invoiceCounter !== undefined) {
    refs.push(`  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${escapeXml(String(invoice.invoiceCounter))}</cbc:UUID>
  </cac:AdditionalDocumentReference>`);
  }

  if (invoice.previousInvoiceHash) {
    refs.push(`  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cbc:DocumentDescription>${escapeXml(invoice.previousInvoiceHash)}</cbc:DocumentDescription>
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
${indent}  <cbc:BuildingNumber>${escapeXml(addr.building)}</cbc:BuildingNumber>
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
 * PartyIdentification with schemeID="CR", and PartyLegalEntity.
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
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(supplier.address.street)}</cbc:StreetName>
        <cbc:BuildingNumber>${escapeXml(supplier.address.building)}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${escapeXml(supplier.address.district)}</cbc:CitySubdivisionName>
        <cbc:CityName>${escapeXml(supplier.address.city)}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(supplier.address.postalCode)}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${escapeXml(supplier.address.countryCode)}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(supplier.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(supplier.nameAr)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>`;
}

/**
 * AccountingCustomerParty block (B2B invoices only).
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
function xmlMonetaryTotal(invoice: InvoiceData): string {
  const allowanceBlock = invoice.allowanceTotalAmount
    ? `\n    <cbc:AllowanceTotalAmount currencyID="${escapeXml(invoice.currencyCode)}">${formatAmount(invoice.allowanceTotalAmount)}</cbc:AllowanceTotalAmount>`
    : '';

  return `  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(invoice.currencyCode)}">${formatAmount(invoice.lineExtensionAmount)}</cbc:LineExtensionAmount>${allowanceBlock}
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(invoice.currencyCode)}">${formatAmount(invoice.taxExclusiveAmount)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(invoice.currencyCode)}">${formatAmount(invoice.taxInclusiveAmount)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${escapeXml(invoice.currencyCode)}">${formatAmount(invoice.payableAmount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`;
}

/**
 * Single invoice line block with TaxTotal including RoundingAmount.
 */
function xmlInvoiceLine(line: InvoiceLineItem, currencyCode: string): string {
  return `  <cac:InvoiceLine>
    <cbc:ID>${line.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${escapeXml(line.unitCode)}">${formatAmount(line.quantity)}</cbc:InvoicedQuantity>
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
  </cac:InvoiceLine>`;
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

${xmlTaxTotalBlocks(invoice.taxAmount, invoice.currencyCode, invoice.taxSubtotals)}

${xmlMonetaryTotal(invoice)}

${invoiceLineBlocks}
</Invoice>`;
}
