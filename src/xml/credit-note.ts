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
import type {
  CreditNoteData,
  SupplierInfo,
  CustomerInfo,
  PostalAddress,
  TaxSubtotal,
  InvoiceLineItem,
  AllowanceCharge,
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
 * DiscrepancyResponse describes why this credit note corrects the original
 * invoice. It appears before BillingReference in the UBL CreditNote sequence.
 */
function xmlDiscrepancyResponse(creditNote: CreditNoteData): string {
  return `  <cac:DiscrepancyResponse>
    <cbc:ReferenceID>${escapeXml(creditNote.originalInvoiceNumber)}</cbc:ReferenceID>
    <cbc:ResponseCode>01</cbc:ResponseCode>
    <cbc:Description>${escapeXml(creditNote.reason)}</cbc:Description>
  </cac:DiscrepancyResponse>`;
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
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(creditNote.previousInvoiceHash)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
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
${xmlPostalAddress(supplier.address, '      ')}
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
 * AccountingCustomerParty block (B2B credit notes).
 */
function xmlCustomerParty(customer: CustomerInfo): string {
  const addressBlock = customer.address
    ? `\n${xmlPostalAddress(customer.address, '      ')}`
    : '';

  return `  <cac:AccountingCustomerParty>
    <cac:Party>
${addressBlock}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(customer.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(customer.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;
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
 * Allowance/charge block.
 */
function xmlAllowanceCharge(
  charge: AllowanceCharge,
  currencyCode: string,
  indent: string,
  taxCategory?: { id: string; percent: number },
): string {
  const effectiveTaxCategory = charge.taxCategoryId && charge.taxPercent !== undefined
    ? { id: charge.taxCategoryId, percent: charge.taxPercent }
    : taxCategory;
  const taxCategoryBlock = effectiveTaxCategory
    ? `
${indent}  <cac:TaxCategory>
${indent}    <cbc:ID>${escapeXml(effectiveTaxCategory.id)}</cbc:ID>
${indent}    <cbc:Percent>${formatAmount(effectiveTaxCategory.percent)}</cbc:Percent>
${indent}    <cac:TaxScheme>
${indent}      <cbc:ID>VAT</cbc:ID>
${indent}    </cac:TaxScheme>
${indent}  </cac:TaxCategory>`
    : '';

  return `${indent}<cac:AllowanceCharge>
${indent}  <cbc:ChargeIndicator>${charge.chargeIndicator ? 'true' : 'false'}</cbc:ChargeIndicator>
${indent}  <cbc:AllowanceChargeReason>${escapeXml(charge.reason)}</cbc:AllowanceChargeReason>
${indent}  <cbc:Amount currencyID="${escapeXml(currencyCode)}">${formatAmount(charge.amount)}</cbc:Amount>
${taxCategoryBlock}
${indent}</cac:AllowanceCharge>`;
}

/**
 * Document-level allowance/charge blocks.
 */
function xmlAllowanceCharges(creditNote: CreditNoteData): string {
  const defaultTaxCategory = creditNote.taxSubtotals[0]
    ? {
        id: creditNote.taxSubtotals[0].taxCategoryId,
        percent: creditNote.taxSubtotals[0].percent,
      }
    : undefined;
  return (creditNote.allowanceCharges ?? [])
    .map((charge) => xmlAllowanceCharge(charge, creditNote.currencyCode, '  ', defaultTaxCategory))
    .join('\n');
}

/**
 * Legal monetary total block.
 */
function xmlMonetaryTotal(creditNote: CreditNoteData): string {
  const allowanceBlock = creditNote.allowanceTotalAmount
    ? `\n    <cbc:AllowanceTotalAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.allowanceTotalAmount)}</cbc:AllowanceTotalAmount>`
    : '';

  return `  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.lineExtensionAmount)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.taxExclusiveAmount)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.taxInclusiveAmount)}</cbc:TaxInclusiveAmount>${allowanceBlock}
    <cbc:PayableAmount currencyID="${escapeXml(creditNote.currencyCode)}">${formatAmount(creditNote.payableAmount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`;
}

/**
 * Single credit note line block with TaxTotal including RoundingAmount.
 */
function xmlCreditNoteLine(line: InvoiceLineItem, currencyCode: string): string {
  const allowanceCharges = (line.allowanceCharges ?? [])
    .map((charge) =>
      xmlAllowanceCharge(charge, currencyCode, '    ', {
        id: line.taxCategoryId,
        percent: line.taxPercent,
      }),
    )
    .join('\n');
  const allowanceChargeBlock = allowanceCharges ? `\n${allowanceCharges}` : '';

  return `  <cac:InvoiceLine>
    <cbc:ID>${line.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${escapeXml(line.unitCode)}">${formatAmount(line.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(line.lineExtensionAmount)}</cbc:LineExtensionAmount>${allowanceChargeBlock}
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
