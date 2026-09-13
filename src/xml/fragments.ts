import type {
  AllowanceCharge,
  CustomerInfo,
  InvoiceLineItem,
  PostalAddress,
  SupplierInfo,
  TaxSubtotal,
} from '../types.js';
import { escapeXml, formatAmount, formatUnitPrice } from '../utils/xml.js';
import { add } from '../utils/money.js';
import type { DecimalInput } from '../utils/money.js';

export type MonetaryDocument = {
  invoiceCounter?: number;
  previousInvoiceHash?: string;
  currencyCode: string;
  taxAmount: DecimalInput;
  taxSubtotals: TaxSubtotal[];
  allowanceCharges?: AllowanceCharge[];
  allowanceTotalAmount?: DecimalInput;
  lineExtensionAmount: DecimalInput;
  taxExclusiveAmount: DecimalInput;
  taxInclusiveAmount: DecimalInput;
  /** BT-113 — prepaid amount; BR-CO-16: BT-115 = BT-112 − BT-113 + BT-114. */
  prepaidAmount?: DecimalInput;
  /** BT-114 — document-level rounding amount (settles ±halala differences; QR tag 4 carries the resulting BT-115). */
  roundingAmount?: DecimalInput;
  payableAmount: DecimalInput;
};

export function xmlUBLExtensions(): string {
  return `  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent/>
    </ext:UBLExtension>
  </ext:UBLExtensions>`;
}

export function xmlAdditionalDocumentReferences(document: MonetaryDocument): string {
  const refs: string[] = [];

  if (document.invoiceCounter !== undefined) {
    refs.push(`  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${escapeXml(String(document.invoiceCounter))}</cbc:UUID>
  </cac:AdditionalDocumentReference>`);
  }

  if (document.previousInvoiceHash) {
    refs.push(`  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${escapeXml(document.previousInvoiceHash)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>`);
  }

  return refs.join('\n');
}

export function xmlSignature(): string {
  return `  <cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
  </cac:Signature>`;
}

function xmlPostalAddress(addr: PostalAddress, indent: string): string {
  // KSA-23: PlotIdentification sits between BuildingNumber and CitySubdivisionName per the UBL 2.1 element sequence.
  const plotIdentification = addr.additionalNumber
    ? `\n${indent}  <cbc:PlotIdentification>${escapeXml(addr.additionalNumber)}</cbc:PlotIdentification>`
    : '';
  return `${indent}<cac:PostalAddress>
${indent}  <cbc:StreetName>${escapeXml(addr.street)}</cbc:StreetName>
${indent}  <cbc:BuildingNumber>${escapeXml(addr.building)}</cbc:BuildingNumber>${plotIdentification}
${indent}  <cbc:CitySubdivisionName>${escapeXml(addr.district)}</cbc:CitySubdivisionName>
${indent}  <cbc:CityName>${escapeXml(addr.city)}</cbc:CityName>
${indent}  <cbc:PostalZone>${escapeXml(addr.postalCode)}</cbc:PostalZone>${addr.countrySubentity ? `\n${indent}  <cbc:CountrySubentity>${escapeXml(addr.countrySubentity)}</cbc:CountrySubentity>` : ''}
${indent}  <cac:Country>
${indent}    <cbc:IdentificationCode>${escapeXml(addr.countryCode)}</cbc:IdentificationCode>
${indent}  </cac:Country>
${indent}</cac:PostalAddress>`;
}

export function xmlSupplierParty(supplier: SupplierInfo): string {
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

export function xmlCustomerParty(customer: CustomerInfo): string {
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

export function xmlTaxTotalBlocks(
  taxAmount: DecimalInput,
  currencyCode: string,
  subtotals: TaxSubtotal[],
): string {
  const subtotalBlocks = subtotals.map((s) => xmlTaxSubtotal(s, currencyCode)).join('\n');
  const withSubtotals = `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(taxAmount)}</cbc:TaxAmount>
${subtotalBlocks}
  </cac:TaxTotal>`;
  const withTaxCurrency = `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(taxAmount)}</cbc:TaxAmount>
  </cac:TaxTotal>`;

  return `${withSubtotals}\n${withTaxCurrency}`;
}

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

export function xmlAllowanceCharges(document: MonetaryDocument): string {
  const defaultTaxCategory = document.taxSubtotals[0]
    ? {
        id: document.taxSubtotals[0].taxCategoryId,
        percent: document.taxSubtotals[0].percent,
      }
    : undefined;
  return (document.allowanceCharges ?? [])
    .map((charge) => xmlAllowanceCharge(charge, document.currencyCode, '  ', defaultTaxCategory))
    .join('\n');
}

export function xmlMonetaryTotal(document: MonetaryDocument): string {
  const allowanceBlock = document.allowanceTotalAmount
    ? `\n    <cbc:AllowanceTotalAmount currencyID="${escapeXml(document.currencyCode)}">${formatAmount(document.allowanceTotalAmount)}</cbc:AllowanceTotalAmount>`
    : '';
  // UBL LegalMonetaryTotal sequence: ... AllowanceTotalAmount, ChargeTotalAmount,
  // PrepaidAmount (BT-113), PayableRoundingAmount (BT-114), PayableAmount (BT-115).
  const prepaidBlock = document.prepaidAmount
    ? `\n    <cbc:PrepaidAmount currencyID="${escapeXml(document.currencyCode)}">${formatAmount(document.prepaidAmount)}</cbc:PrepaidAmount>`
    : '';
  const roundingBlock = document.roundingAmount
    ? `\n    <cbc:PayableRoundingAmount currencyID="${escapeXml(document.currencyCode)}">${formatAmount(document.roundingAmount)}</cbc:PayableRoundingAmount>`
    : '';

  return `  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(document.currencyCode)}">${formatAmount(document.lineExtensionAmount)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(document.currencyCode)}">${formatAmount(document.taxExclusiveAmount)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(document.currencyCode)}">${formatAmount(document.taxInclusiveAmount)}</cbc:TaxInclusiveAmount>${allowanceBlock}${prepaidBlock}${roundingBlock}
    <cbc:PayableAmount currencyID="${escapeXml(document.currencyCode)}">${formatAmount(document.payableAmount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`;
}

export function xmlInvoiceLine(line: InvoiceLineItem, currencyCode: string): string {
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
    <cbc:InvoicedQuantity unitCode="${escapeXml(line.unitCode)}">${formatUnitPrice(line.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(line.lineExtensionAmount)}</cbc:LineExtensionAmount>${allowanceChargeBlock}
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(line.taxAmount)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${escapeXml(currencyCode)}">${formatAmount(add(line.lineExtensionAmount, line.taxAmount))}</cbc:RoundingAmount>
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
      <cbc:PriceAmount currencyID="${escapeXml(currencyCode)}">${formatUnitPrice(line.priceAmount)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
}
