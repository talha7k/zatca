import { describe, expect, test } from 'bun:test';

import { ZatcaError, ZatcaErrorCode } from '../../src/errors.js';
import type { CSRParams, InvoiceData } from '../../src/types.js';
import { validateCSRParams, validateInvoice } from '../../src/utils/validation.js';

// ---------------------------------------------------------------------------
// Characterization tests for validateInvoice and validateCSRParams, plus the
// regression tests for the formerly pinned quirks (missing CSR vatNumber
// TypeError, undefined invoice totals accepted) — those were resolved
// deliberately: missing/empty values now produce clean ZatcaErrors.
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<InvoiceData> = {}): InvoiceData {
  return {
    invoiceNumber: 'INV-001',
    uuid: '6fae93ca-60a7-47a9-8a2a-76df9a2b1595',
    issueDate: '2026-01-15',
    issueTime: '14:30:00',
    invoiceTypeCode: '388',
    invoiceTypeCodeName: 'Standard',
    profileId: 'reporting:1.0',
    currencyCode: 'SAR',
    supplier: {
      nameAr: 'شركة الاختبار',
      nameEn: 'Test Company',
      vatNumber: '300000000000003',
      address: {
        city: 'Riyadh',
        street: 'King Fahd Road',
        postalCode: '12345',
      },
    },
    lineExtensionAmount: 100,
    taxExclusiveAmount: 100,
    taxInclusiveAmount: 115,
    payableAmount: 115,
    taxAmount: 15,
    taxSubtotals: [],
    invoiceLines: [
      {
        id: 1,
        quantity: 1,
        unitCode: 'C62',
        lineExtensionAmount: 100,
        taxAmount: 15,
        itemName: 'Test item',
        taxCategoryId: 'S',
        taxPercent: 15,
        priceAmount: 100,
      },
    ],
    ...overrides,
  } as InvoiceData;
}

function makeCSRParams(overrides: Partial<CSRParams> = {}): CSRParams {
  return {
    organizationNameAr: 'شركة الاختبار',
    organizationNameEn: 'Test Company',
    vatNumber: '300000000000003',
    crNumber: '1010101010',
    country: 'SA',
    commonName: 'TestCompany',
    invoiceType: '1100',
    location: {
      city: 'Riyadh',
      district: 'Al Olaya',
      street: 'King Fahd Road',
      buildingNumber: '1234',
      postalCode: '12345',
    },
    egsSerialNumber: 'EGS-001',
    ...overrides,
  } as CSRParams;
}

interface CapturedError {
  message: string;
  code: ZatcaErrorCode;
  details: { errors?: string[] } | undefined;
}

function captureValidationError(invoke: () => void): CapturedError {
  try {
    invoke();
  } catch (error) {
    expect(error).toBeInstanceOf(ZatcaError);
    const zatcaError = error as ZatcaError;
    return {
      message: zatcaError.message,
      code: zatcaError.code,
      details: zatcaError.details as CapturedError['details'],
    };
  }
  throw new Error('expected validation to throw, but it passed');
}

// ---------------------------------------------------------------------------
// validateInvoice — valid input
// ---------------------------------------------------------------------------

describe('validateInvoice (characterization)', () => {
  test('accepts a valid minimal invoice without throwing', () => {
    expect(() => validateInvoice(makeInvoice())).not.toThrow();
  });

  test('accepts zero amounts (boundary — only negatives are rejected)', () => {
    expect(() =>
      validateInvoice(makeInvoice({ taxAmount: 0, payableAmount: 0 })),
    ).not.toThrow();
  });

  test('accepts an exactly-15-digit VAT number', () => {
    expect(() => validateInvoice(makeInvoice())).not.toThrow();
  });

  test('accepts undefined allowanceCharges (optional, skipped)', () => {
    const invoice = makeInvoice();
    delete (invoice as { allowanceCharges?: unknown }).allowanceCharges;
    invoice.invoiceLines = invoice.invoiceLines.map((line) => ({
      ...line,
      allowanceCharges: undefined,
    }));
    expect(() => validateInvoice(invoice)).not.toThrow();
  });

  // ---------------------------------------------------------------------
  // Required header fields
  // ---------------------------------------------------------------------

  test.each([
    ['invoiceNumber'],
    ['uuid'],
    ['issueDate'],
    ['issueTime'],
    ['invoiceTypeCode'],
    ['currencyCode'],
  ] as const)('rejects missing %s', (field) => {
    const invoice = makeInvoice({ [field]: undefined } as Partial<InvoiceData>);
    const captured = captureValidationError(() => validateInvoice(invoice));
    expect(captured.code).toBe(ZatcaErrorCode.VALIDATION_ERROR);
    expect(captured.message).toBe(
      `Invoice validation failed: ${field} is required`,
    );
    expect(captured.details?.errors).toEqual([`${field} is required`]);
  });

  test.each([
    ['nameAr', 'supplier.nameAr is required'],
    ['nameEn', 'supplier.nameEn is required'],
    ['vatNumber', 'supplier.vatNumber is required'],
    ['city', 'supplier.address.city is required'],
    ['street', 'supplier.address.street is required'],
    ['postalCode', 'supplier.address.postalCode is required'],
  ] as const)('rejects missing supplier.%s', (field, expectedError) => {
    const invoice = makeInvoice();
    const supplier = { ...invoice.supplier } as Record<string, unknown>;
    if (field === 'city' || field === 'street' || field === 'postalCode') {
      supplier.address = { ...(supplier.address as Record<string, unknown>), [field]: undefined } as unknown as typeof invoice.supplier.address;
    } else {
      supplier[field] = undefined;
    }
    invoice.supplier = supplier as unknown as typeof invoice.supplier;
    const captured = captureValidationError(() => validateInvoice(invoice));
    expect(captured.details?.errors).toEqual([expectedError]);
  });

  // ---------------------------------------------------------------------
  // VAT number length
  // ---------------------------------------------------------------------

  test('rejects a 14-digit VAT number with the length message', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({ supplier: { ...makeInvoice().supplier, vatNumber: '30000000000003' } })),
    );
    expect(captured.details?.errors).toEqual(['supplier.vatNumber must be 15 digits']);
    expect(captured.message).toBe(
      'Invoice validation failed: supplier.vatNumber must be 15 digits',
    );
  });

  test('rejects a 16-digit VAT number with the length message', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({ supplier: { ...makeInvoice().supplier, vatNumber: '3000000000000031' } })),
    );
    expect(captured.details?.errors).toEqual(['supplier.vatNumber must be 15 digits']);
  });

  test('empty-string VAT number produces only the required error (no length error)', () => {
    // Pins current behavior: the length check is guarded by truthiness.
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({ supplier: { ...makeInvoice().supplier, vatNumber: '' } })),
    );
    expect(captured.details?.errors).toEqual(['supplier.vatNumber is required']);
  });

  // ---------------------------------------------------------------------
  // Amounts
  // ---------------------------------------------------------------------

  test('rejects a negative taxAmount', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({ taxAmount: -0.01 })),
    );
    expect(captured.details?.errors).toEqual(['taxAmount must be non-negative']);
  });

  test('rejects a negative payableAmount', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({ payableAmount: -1 })),
    );
    expect(captured.details?.errors).toEqual(['payableAmount must be non-negative']);
  });

  test.each([
    ['taxAmount'],
    ['payableAmount'],
  ] as const)('rejects a missing (undefined) %s with the required error', (field) => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({ [field]: undefined } as Partial<InvoiceData>)),
    );
    expect(captured.code).toBe(ZatcaErrorCode.VALIDATION_ERROR);
    expect(captured.details?.errors).toEqual([`${field} is required`]);
  });

  test('rejects null totals with the required errors', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({
        taxAmount: null,
        payableAmount: null,
      } as unknown as Partial<InvoiceData>)),
    );
    expect(captured.details?.errors).toEqual([
      'taxAmount is required',
      'payableAmount is required',
    ]);
  });

  // ---------------------------------------------------------------------
  // Invoice-level allowance charges
  // ---------------------------------------------------------------------

  test('rejects an invoice-level allowance charge with no reason', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({
        allowanceCharges: [{ chargeIndicator: false, reason: '', amount: 5 }],
      })),
    );
    expect(captured.details?.errors).toEqual(['allowanceCharges.reason is required']);
  });

  test('rejects an invoice-level allowance charge with a negative amount', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({
        allowanceCharges: [{ chargeIndicator: false, reason: 'discount', amount: -5 }],
      })),
    );
    expect(captured.details?.errors).toEqual(['allowanceCharges.amount must be non-negative']);
  });

  test('validates every invoice-level allowance charge and reports both errors in order', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({
        allowanceCharges: [
          { chargeIndicator: false, reason: '', amount: -1 },
          { chargeIndicator: false, reason: 'ok', amount: 1 },
          { chargeIndicator: false, reason: '', amount: 2 },
        ],
      })),
    );
    expect(captured.details?.errors).toEqual([
      'allowanceCharges.reason is required',
      'allowanceCharges.amount must be non-negative',
      'allowanceCharges.reason is required',
    ]);
  });

  // ---------------------------------------------------------------------
  // Line items
  // ---------------------------------------------------------------------

  test.each([
    ['empty array', []],
    ['undefined', undefined],
  ] as const)('rejects %s invoiceLines with the singular required error', (_label, lines) => {
    const invoice = makeInvoice({ invoiceLines: lines } as Partial<InvoiceData>);
    const captured = captureValidationError(() => validateInvoice(invoice));
    expect(captured.details?.errors).toEqual(['At least one invoice line is required']);
  });

  test('rejects a line allowance charge with no reason', () => {
    const invoice = makeInvoice();
    invoice.invoiceLines = [
      { ...invoice.invoiceLines[0], allowanceCharges: [{ chargeIndicator: false, reason: '', amount: 1 }] },
    ];
    const captured = captureValidationError(() => validateInvoice(invoice));
    expect(captured.details?.errors).toEqual(['invoiceLines.allowanceCharges.reason is required']);
  });

  test('rejects a line allowance charge with a negative amount', () => {
    const invoice = makeInvoice();
    invoice.invoiceLines = [
      { ...invoice.invoiceLines[0], allowanceCharges: [{ chargeIndicator: false, reason: 'discount', amount: -1 }] },
    ];
    const captured = captureValidationError(() => validateInvoice(invoice));
    expect(captured.details?.errors).toEqual(['invoiceLines.allowanceCharges.amount must be non-negative']);
  });

  test('validates allowance charges across multiple lines', () => {
    const invoice = makeInvoice();
    invoice.invoiceLines = [
      { ...invoice.invoiceLines[0], allowanceCharges: [{ chargeIndicator: false, reason: '', amount: -1 }] },
      { ...invoice.invoiceLines[0], allowanceCharges: [{ chargeIndicator: false, reason: '', amount: 1 }] },
    ];
    const captured = captureValidationError(() => validateInvoice(invoice));
    expect(captured.details?.errors).toEqual([
      'invoiceLines.allowanceCharges.reason is required',
      'invoiceLines.allowanceCharges.amount must be non-negative',
      'invoiceLines.allowanceCharges.reason is required',
    ]);
  });

  // ---------------------------------------------------------------------
  // Aggregation, ordering, and error shape
  // ---------------------------------------------------------------------

  test('aggregates ALL errors from an empty invoice in exact check order', () => {
    const captured = captureValidationError(() =>
      validateInvoice({} as unknown as InvoiceData),
    );
    const expectedErrors = [
      'invoiceNumber is required',
      'uuid is required',
      'issueDate is required',
      'issueTime is required',
      'invoiceTypeCode is required',
      'currencyCode is required',
      'supplier.nameAr is required',
      'supplier.nameEn is required',
      'supplier.vatNumber is required',
      'supplier.address.city is required',
      'supplier.address.street is required',
      'supplier.address.postalCode is required',
      'taxAmount is required',
      'payableAmount is required',
      'At least one invoice line is required',
    ];
    expect(captured.details?.errors).toEqual(expectedErrors);
    expect(captured.message).toBe(
      `Invoice validation failed: ${expectedErrors.join('; ')}`,
    );
    expect(captured.code).toBe(ZatcaErrorCode.VALIDATION_ERROR);
  });

  test('header errors precede amount errors (section ordering)', () => {
    const captured = captureValidationError(() =>
      validateInvoice(makeInvoice({ invoiceNumber: '', taxAmount: -1 })),
    );
    expect(captured.details?.errors).toEqual([
      'invoiceNumber is required',
      'taxAmount must be non-negative',
    ]);
  });

  test('amount errors precede line-item errors (section ordering)', () => {
    const invoice = makeInvoice({ taxAmount: -1 });
    invoice.invoiceLines = [
      { ...invoice.invoiceLines[0], allowanceCharges: [{ chargeIndicator: false, reason: '', amount: 1 }] },
    ];
    const captured = captureValidationError(() => validateInvoice(invoice));
    expect(captured.details?.errors).toEqual([
      'taxAmount must be non-negative',
      'invoiceLines.allowanceCharges.reason is required',
    ]);
  });

  test('throws a ZatcaError instance', () => {
    try {
      validateInvoice({} as unknown as InvoiceData);
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(ZatcaError);
      expect((error as ZatcaError).name).toBe('ZatcaError');
    }
  });
});

// ---------------------------------------------------------------------------
// validateCSRParams — characterized because it lives in the same file and is
// decomposed alongside validateInvoice.
// ---------------------------------------------------------------------------

describe('validateCSRParams (characterization)', () => {
  test('accepts valid CSR params without throwing', () => {
    expect(() => validateCSRParams(makeCSRParams())).not.toThrow();
  });

  test.each([
    ['organizationNameAr'],
    ['organizationNameEn'],
    ['crNumber'],
    ['commonName'],
    ['egsSerialNumber'],
  ] as const)('rejects missing %s', (field) => {
    const captured = captureValidationError(() =>
      validateCSRParams(makeCSRParams({ [field]: undefined } as Partial<CSRParams>)),
    );
    expect(captured.code).toBe(ZatcaErrorCode.VALIDATION_ERROR);
    expect(captured.details?.errors).toEqual([`${field} is required`]);
    expect(captured.message).toBe(`CSR validation failed: ${field} is required`);
  });

  test('rejects a VAT number of the wrong length', () => {
    const captured = captureValidationError(() =>
      validateCSRParams(makeCSRParams({ vatNumber: '30000000000003' })),
    );
    expect(captured.details?.errors).toEqual(['vatNumber must be 15 digits']);
  });

  test('rejects a missing VAT number with a clean ZatcaError (no raw TypeError)', () => {
    // Mirrors validateInvoice's supplier check: a missing vatNumber reports
    // the required error instead of crashing on `params.vatNumber.length`.
    const captured = captureValidationError(() =>
      validateCSRParams(makeCSRParams({ vatNumber: undefined } as Partial<CSRParams>)),
    );
    expect(captured.code).toBe(ZatcaErrorCode.VALIDATION_ERROR);
    expect(captured.details?.errors).toEqual(['vatNumber is required']);
    expect(captured.message).toBe('CSR validation failed: vatNumber is required');
  });

  test.each([
    ['city', 'location.city is required'],
    ['district', 'location.district is required'],
    ['street', 'location.street is required'],
    ['buildingNumber', 'location.buildingNumber is required'],
    ['postalCode', 'location.postalCode is required'],
  ] as const)('rejects missing location.%s', (field, expectedError) => {
    const params = makeCSRParams();
    params.location = { ...params.location, [field]: undefined } as typeof params.location;
    const captured = captureValidationError(() => validateCSRParams(params));
    expect(captured.details?.errors).toEqual([expectedError]);
  });

  test('aggregates all errors in check order (org fields, then location fields)', () => {
    const captured = captureValidationError(() =>
      validateCSRParams({
        organizationNameAr: '',
        organizationNameEn: '',
        vatNumber: '123',
        crNumber: '',
        country: 'SA',
        commonName: '',
        invoiceType: '1100',
        location: {
          city: '',
          district: '',
          street: '',
          buildingNumber: '',
          postalCode: '',
        },
        egsSerialNumber: '',
      } as unknown as CSRParams),
    );
    // vatNumber is truthy ('123'), so only the length error is reported.
    expect(captured.details?.errors).toEqual([
      'organizationNameAr is required',
      'organizationNameEn is required',
      'vatNumber must be 15 digits',
      'crNumber is required',
      'commonName is required',
      'egsSerialNumber is required',
      'location.city is required',
      'location.district is required',
      'location.street is required',
      'location.buildingNumber is required',
      'location.postalCode is required',
    ]);
    expect(captured.message).toBe('CSR validation failed: organizationNameAr is required; organizationNameEn is required; vatNumber must be 15 digits; crNumber is required; commonName is required; egsSerialNumber is required; location.city is required; location.district is required; location.street is required; location.buildingNumber is required; location.postalCode is required');
  });

  test('rejects a completely empty params object with an aggregated ZatcaError (no raw TypeError)', () => {
    // Same root cause as the missing-vatNumber case above: with the guard in
    // place, an empty object aggregates every required error in check order.
    const captured = captureValidationError(() =>
      validateCSRParams({} as unknown as CSRParams),
    );
    expect(captured.code).toBe(ZatcaErrorCode.VALIDATION_ERROR);
    expect(captured.details?.errors).toEqual([
      'organizationNameAr is required',
      'organizationNameEn is required',
      'vatNumber is required',
      'crNumber is required',
      'commonName is required',
      'egsSerialNumber is required',
      'location.city is required',
      'location.district is required',
      'location.street is required',
      'location.buildingNumber is required',
      'location.postalCode is required',
    ]);
  });
});
