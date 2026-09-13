import { describe, expect, test } from 'bun:test';
import { extractValidationDiagnostics, assertNoZatcaAlerts } from '../../src/api/diagnostics.js';
import { parseInvoiceListResponse, parseSubmissionResponse } from '../../src/api/submission-response.js';
import { ZatcaError } from '../../src/errors.js';
import type { ZatcaSubmitResult } from '../../src/types.js';

// Fixtures mirror the real ZATCA sandbox responses documented in
// docs/sandbox/04-reporting-single.md, 05-clearance-single.md and
// 02-compliance-invoices.md — including the EN/AR bilingual validation text
// the portal returns.

const response = (status: number, body: unknown | string) => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const REPORTED_200 = {
  validationResults: {
    infoMessages: [
      {
        type: 'INFO',
        code: 'XSD_ZATCA_VALID',
        category: 'XSD validation',
        message: 'Complied with UBL 2.1 standards in line with ZATCA specifications',
        status: 'PASS',
      },
    ],
    warningMessages: [],
    errorMessages: [],
    status: 'PASS',
  },
  reportingStatus: 'REPORTED',
};

const WARNED_202 = {
  validationResults: {
    warningMessages: [
      {
        type: 'WARNING',
        code: 'BR-CO-17',
        category: 'EN_16931',
        message:
          'VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.',
        status: 'WARNING',
      },
      {
        type: 'WARNING',
        code: 'BR-KSA-98',
        category: 'KSA',
        message: '[BR-KSA-98] - يجب تقديم الفاتورة المبسطة خلال 24 ساعة من إصدارها',
        status: 'WARNING',
      },
    ],
    errorMessages: [],
    status: 'WARNING',
  },
};

const ERRORED_400 = {
  validationResults: {
    errorMessages: [
      {
        type: 'ERROR',
        code: 'invalid-invoice-hash',
        category: 'INVOICE_HASHING_ERRORS',
        message: 'The invoice hash API body does not match the (calculated) Hash of the XML',
        status: 'ERROR',
      },
      {
        type: 'ERROR',
        code: 'invoiceHash_QRCODE_INVALID',
        category: 'QRCODE_VALIDATION',
        message: 'Invoice xml hash does not match with qr code invoice xml hash',
        status: 'ERROR',
      },
    ],
    status: 'ERROR',
  },
  reportingStatus: 'NOT_REPORTED',
};

const CLEARED_200 = {
  acceptedInvoices: [
    {
      uuid: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      invoiceHash: 'aGVsbG8tY2xlYXJlZC1oYXNo',
      clearedInvoice: 'Y2xlYXJlZC1pbnZvaWNlLXhtbA==',
      clearanceDateTime: '2026-01-15T10:30:00Z',
      clearanceStatus: 'CLEARED',
    },
  ],
};

const REJECTED_200 = {
  rejectededInvoices: [
    {
      uuid: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      invoiceHash: 'aGVsbG8tcmVqZWN0ZWQtaGFzaA==',
      error: {
        category: 'BR-E-01',
        code: 'BR-E-01',
        message: 'Rejection: no VAT breakdown',
      },
      warnings: [
        { category: 'BR-W-01', code: 'BR-W-01', message: 'Warning: check rounding' },
      ],
    },
  ],
};

describe('extractValidationDiagnostics · clean & warned responses', () => {
  test('a clean PASS yields no error, no warnings, no alerts', () => {
    const diagnostics = extractValidationDiagnostics(REPORTED_200.validationResults);

    expect(diagnostics.error).toBeUndefined();
    expect(diagnostics.warnings).toEqual([]);
    expect(diagnostics.alerts).toEqual([]);
  });

  test('normalizes warnings preserving code, category and EN/AR messages', () => {
    const diagnostics = extractValidationDiagnostics(WARNED_202.validationResults);

    expect(diagnostics.error).toBeUndefined();
    expect(diagnostics.warnings).toHaveLength(2);
    expect(diagnostics.warnings[0]).toEqual({
      code: 'BR-CO-17',
      category: 'EN_16931',
      message:
        'VAT category tax amount (BT-117) = VAT category taxable amount (BT-116) x (VAT category rate (BT-119) / 100), rounded to two decimals.',
    });
    expect(diagnostics.warnings[1]!.message).toContain('يجب تقديم الفاتورة المبسطة');
    expect(diagnostics.alerts).toEqual([
      { severity: 'warning', ...diagnostics.warnings[0] },
      { severity: 'warning', ...diagnostics.warnings[1] },
    ]);
  });
});

describe('extractValidationDiagnostics · error aggregation & defensive fallbacks', () => {
  test('aggregates multiple errors into one joined error object', () => {
    const diagnostics = extractValidationDiagnostics(ERRORED_400.validationResults);

    expect(diagnostics.error).toBeDefined();
    expect(diagnostics.error!.code).toBe('invalid-invoice-hash,invoiceHash_QRCODE_INVALID');
    expect(diagnostics.error!.category).toBe('INVOICE_HASHING_ERRORS,QRCODE_VALIDATION');
    expect(diagnostics.error!.message).toBe(
      'invalid-invoice-hash: The invoice hash API body does not match the (calculated) Hash of the XML; ' +
        'invoiceHash_QRCODE_INVALID: Invoice xml hash does not match with qr code invoice xml hash',
    );
    expect(diagnostics.alerts.map((alert) => alert.severity)).toEqual(['error', 'error']);
  });

  test('applies fallback code/category/message for sparse ZATCA entries', () => {
    const diagnostics = extractValidationDiagnostics({
      errorMessages: [{ message: 'oops' }],
      warningMessages: [{}],
    });

    expect(diagnostics.error!.code).toBe('ZATCA_VALIDATION_ERROR');
    expect(diagnostics.error!.category).toBe('ZATCA');
    expect(diagnostics.warnings[0]).toEqual({
      code: 'ZATCA_WARNING',
      category: 'ZATCA',
      message: 'ZATCA returned a warning for the submitted document',
    });
  });

  test('handles missing/undefined validationResults defensively', () => {
    const diagnostics = extractValidationDiagnostics(undefined);

    expect(diagnostics.error).toBeUndefined();
    expect(diagnostics.warnings).toEqual([]);
    expect(diagnostics.alerts).toEqual([]);
  });
});

const clearanceParse = (res: { status: number; body: string }) =>
  parseSubmissionResponse(res, { parseErrorMessage: 'Failed to parse clearance response' }, (data) =>
    parseInvoiceListResponse(res, data, { includeClearanceStatus: true }),
  );

describe('parseInvoiceListResponse (clearance single list shape) · accepted & rejected invoices', () => {
  test('accepted invoice → success with clearance fields surfaced', () => {
    const res = response(200, CLEARED_200);
    const result = clearanceParse(res);

    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.response!.status).toBe('ACCEPTED');
    expect(result.response!.uuid).toBe('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d');
    expect(result.response!.invoiceHash).toBe('aGVsbG8tY2xlYXJlZC1oYXNo');
    expect(result.response!.clearedInvoice).toBe('Y2xlYXJlZC1pbnZvaWNlLXhtbA==');
    expect(result.response!.clearanceDateTime).toBe('2026-01-15T10:30:00Z');
    expect(result.response!.clearanceStatus).toBe('CLEARED');
    expect(result.response!.reportingStatus).toBeUndefined();
    expect(result.rawBody).toBe(res.body);
  });

  test('rejected invoice → failure with normalized error and warning alerts', () => {
    const res = response(200, REJECTED_200);
    const result = clearanceParse(res);

    expect(result.success).toBe(false);
    expect(result.response!.status).toBe('REJECTED');
    expect(result.error).toEqual({
      code: 'BR-E-01',
      category: 'BR-E-01',
      message: 'Rejection: no VAT breakdown',
    });
    expect(result.response!.warnings).toEqual([
      { code: 'BR-W-01', category: 'BR-W-01', message: 'Warning: check rounding' },
    ]);
    expect(result.alerts).toEqual([
      { severity: 'warning', code: 'BR-W-01', category: 'BR-W-01', message: 'Warning: check rounding' },
    ]);
  });
});

describe('parseInvoiceListResponse (clearance single list shape) · list-shape edge cases', () => {
  test('merges document-level validationResults diagnostics into the alerts', () => {
    const res = response(400, { ...ERRORED_400, rejectededInvoices: REJECTED_200.rejectededInvoices });
    const result = parseInvoiceListResponse(res, JSON.parse(res.body), { includeClearanceStatus: true });

    expect(result!.success).toBe(false);
    expect(result!.error!.code).toBe('BR-E-01'); // invoice-level error wins
    expect(result!.alerts!.map((alert) => alert.code)).toEqual([
      'invalid-invoice-hash',
      'invoiceHash_QRCODE_INVALID',
      'BR-W-01',
    ]);
  });

  test('accepts the rejectedInvoices spelling as well as rejectededInvoices', () => {
    const res = response(200, { rejectedInvoices: REJECTED_200.rejectededInvoices });
    const result = parseInvoiceListResponse(res, JSON.parse(res.body), {});

    expect(result!.success).toBe(false);
    expect(result!.response!.status).toBe('REJECTED');
  });

  test('returns undefined when the body has no invoice entries', () => {
    const res = response(200, { validationResults: REPORTED_200.validationResults });

    expect(parseInvoiceListResponse(res, JSON.parse(res.body), {})).toBeUndefined();
    expect(parseInvoiceListResponse(res, {}, {})).toBeUndefined();
  });

  test('status fields stay undefined unless explicitly requested', () => {
    const res = response(200, CLEARED_200);
    const result = parseInvoiceListResponse(res, JSON.parse(res.body), {});

    expect(result!.response!.clearanceStatus).toBeUndefined();
    expect(result!.response!.reportingStatus).toBeUndefined();
  });
});

describe('parseSubmissionResponse · successful parses', () => {
  test('returns the parsed result with raw body and status preserved', () => {
    const res = response(202, WARNED_202);
    const result = parseSubmissionResponse(res, { parseErrorMessage: 'parse fail' }, (data) => {
      // Real parseData callbacks (clearance/reporting) set rawBody themselves.
      expect(data).toEqual(WARNED_202);
      return {
        success: true,
        httpStatus: res.status,
        rawBody: res.body,
        alerts: [{ severity: 'warning', code: 'BR-KSA-98', category: 'KSA', message: 'late' }],
      };
    });

    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(202);
    expect(result.rawBody).toBe(res.body);
    expect(result.alerts).toHaveLength(1);
  });

  test('falls back to HTTP-derived success when the parser yields nothing (2xx)', () => {
    const res = response(201, { note: 'unrecognized but valid JSON' });
    const result = parseSubmissionResponse(res, { parseErrorMessage: 'parse fail' }, () => undefined);

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(result.rawBody).toBe(res.body);
  });
});

describe('parseSubmissionResponse · failure shapes', () => {
  test('marks non-2xx bodies without invoice entries as unsuccessful', () => {
    const res = response(500, { message: 'boom' });
    const result = parseSubmissionResponse(res, { parseErrorMessage: 'parse fail' }, () => undefined);

    expect(result.success).toBe(false);
  });

  test('wraps malformed JSON into a PARSE_ERROR result (CLIENT category)', () => {
    const res = response(200, '<html>Gateway Timeout</html>');
    const result = parseSubmissionResponse(
      res,
      { parseErrorMessage: 'Failed to parse clearance response' },
      () => undefined,
    );

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(200);
    expect(result.error!.code).toBe('PARSE_ERROR');
    expect(result.error!.category).toBe('CLIENT');
    expect(result.error!.message).toContain('Failed to parse clearance response');
    expect(result.alerts![0]!.severity).toBe('error');
    expect(result.rawBody).toBe('<html>Gateway Timeout</html>');
  });

  test('parseData throwing on unexpected JSON shapes surfaces as PARSE_ERROR', () => {
    const res = response(200, 'null');
    const result = parseSubmissionResponse(
      res,
      { parseErrorMessage: 'Failed to parse ZATCA response' },
      (data) => parseInvoiceListResponse(res, data, {}),
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('PARSE_ERROR');
  });
});

describe('assertNoZatcaAlerts', () => {
  test('accepts a clean successful result', () => {
    const clean: ZatcaSubmitResult = { success: true, httpStatus: 200, alerts: [] };

    expect(() => assertNoZatcaAlerts(clean, 'Reporting')).not.toThrow();
  });

  test('throws ZatcaError API_ERR summarizing warnings on a successful result', () => {
    const warned: ZatcaSubmitResult = {
      success: true,
      httpStatus: 202,
      rawBody: '{"reportingStatus":"REPORTED"}',
      alerts: [
        { severity: 'warning', code: 'BR-KSA-98', category: 'KSA', message: 'submit within 24 hours' },
      ],
    };

    try {
      assertNoZatcaAlerts(warned, 'Reporting');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ZatcaError);
      expect((error as ZatcaError).code).toBe('API_ERR');
      expect((error as ZatcaError).message).toContain('Reporting failed');
      expect((error as ZatcaError).message).toContain('WARNING BR-KSA-98: submit within 24 hours');
      expect((error as ZatcaError).details).toEqual({
        httpStatus: 202,
        error: undefined,
        alerts: warned.alerts,
        rawBody: '{"reportingStatus":"REPORTED"}',
      });
    }
  });

  test('reports the HTTP status when a failed result carries no alerts', () => {
    const failed: ZatcaSubmitResult = {
      success: false,
      httpStatus: 500,
      error: { code: 'INTERNAL', category: 'ZATCA', message: 'internal error' },
    };

    try {
      assertNoZatcaAlerts(failed, 'Clearance');
      expect.unreachable();
    } catch (error) {
      expect((error as ZatcaError).message).toBe('Clearance failed: internal error');
      expect((error as ZatcaError).code).toBe('API_ERR');
    }
  });
});
