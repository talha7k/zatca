import type { CSRParams, CreditNoteData, InvoiceData } from '../../src/types.js';

export const TEST_CSR_PARAMS: CSRParams = {
  organizationNameAr: 'شركة اختبار',
  organizationNameEn: 'Test Company',
  vatNumber: '300000000000003', // 15 digits starting and ending with 3
  crNumber: '1010010000',
  country: 'SA',
  commonName: 'Test Company',
  invoiceType: '1100', // 4-digit: standard+simplified (matching official spec)
  businessCategory: 'Technology',
  location: {
    city: 'Riyadh',
    district: 'Al Olaya',
    street: 'King Fahd Road',
    buildingNumber: '8008',
    postalCode: '12345',
  },
  // ZATCA requires format: 1-{solutionName}|2-{model}|3-{serialNumber}
  egsSerialNumber: '1-TST|2-TST|3-EGS30000000000000301',
};

/**
 * Create a test invoice with sensible defaults.
 * Pass overrides to customize specific fields (e.g. invoiceNumber, invoiceCounter).
 */
export function createTestInvoice(overrides?: Partial<InvoiceData>): InvoiceData {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = now.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS

  return {
    invoiceNumber: 'SME00001',
    uuid: crypto.randomUUID(),
    issueDate: dateStr,
    issueTime: timeStr,
    invoiceTypeCode: '388', // Simplified
    invoiceTypeCodeName: '0200000',
    profileId: 'reporting:1.0',
    currencyCode: 'SAR',
    invoiceCounter: 1,
    previousInvoiceHash:
      'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==', // base64 of 32 zero bytes

    supplier: {
      nameAr: 'شركة اختبار',
      nameEn: 'Test Company',
      vatNumber: '300000000000003',
      crNumber: '1010010000',
      address: {
        street: 'King Fahd Road',
        building: '8008',
        district: 'Al Olaya',
        city: 'Riyadh',
        postalCode: '12345',
        countryCode: 'SA',
      },
    },

    lineExtensionAmount: 4.0,
    taxExclusiveAmount: 4.0,
    taxInclusiveAmount: 4.6,
    allowanceTotalAmount: 0,
    payableAmount: 4.6,
    taxAmount: 0.6,

    taxSubtotals: [
      {
        taxableAmount: 4.0,
        taxAmount: 0.6,
        percent: 15,
        taxCategoryId: 'S',
      },
    ],

    invoiceLines: [
      {
        id: 1,
        quantity: 2,
        unitCode: 'PCE',
        lineExtensionAmount: 4.0,
        taxAmount: 0.6,
        itemName: 'Product',
        taxCategoryId: 'S',
        taxPercent: 15,
        priceAmount: 2.0,
      },
    ],

    ...overrides,
  };
}

export function createDiscountedTestInvoice(overrides?: Partial<InvoiceData>): InvoiceData {
  return createTestInvoice({
    lineExtensionAmount: 100,
    taxExclusiveAmount: 90,
    taxInclusiveAmount: 103.5,
    allowanceTotalAmount: 10,
    allowanceCharges: [
      {
        chargeIndicator: false,
        reason: 'Discount',
        amount: 10,
      },
    ],
    payableAmount: 103.5,
    taxAmount: 13.5,
    taxSubtotals: [
      {
        taxableAmount: 90,
        taxAmount: 13.5,
        percent: 15,
        taxCategoryId: 'S',
      },
    ],
    invoiceLines: [
      {
        id: 1,
        quantity: 1,
        unitCode: 'PCE',
        lineExtensionAmount: 100,
        taxAmount: 13.5,
        itemName: 'Discounted Product',
        taxCategoryId: 'S',
        taxPercent: 15,
        priceAmount: 100,
      },
    ],
    ...overrides,
  });
}

export function createTestCreditNote(overrides?: Partial<CreditNoteData>): CreditNoteData {
  return {
    ...createTestInvoice({
      invoiceNumber: 'SCN00001',
      invoiceTypeCode: '381',
      invoiceTypeCodeName: '0200000',
      profileId: 'reporting:1.0',
    }),
    originalInvoiceNumber: 'SME00001',
    originalInvoiceUuid: crypto.randomUUID(),
    originalInvoiceDate: new Date().toISOString().split('T')[0],
    reason: 'Returned goods',
    ...overrides,
  };
}
