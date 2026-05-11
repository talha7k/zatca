import type {
  ZatcaApiError,
  ZatcaApiWarning,
  ZatcaSubmitResult,
} from '../types.js';
import { extractValidationDiagnostics } from './diagnostics.js';

type RawInvoiceResult = {
  uuid?: string;
  invoiceHash?: string;
  clearedInvoice?: string;
  clearanceDateTime?: string;
  clearanceStatus?: string;
  reportingStatus?: string;
  error?: Partial<ZatcaApiError>;
  warnings?: Array<Partial<ZatcaApiWarning>>;
};

type SubmissionParseOptions = {
  parseErrorMessage: string;
  includeReportingStatus?: boolean;
  includeClearanceStatus?: boolean;
};

function normalizeInvoiceError(error?: Partial<ZatcaApiError>): ZatcaApiError | undefined {
  return error
    ? {
        code: error.code || '',
        category: error.category || '',
        message: error.message || '',
      }
    : undefined;
}

function normalizeInvoiceWarnings(warnings?: Array<Partial<ZatcaApiWarning>>): ZatcaApiWarning[] {
  return (warnings || []).map((warning) => ({
    code: warning.code || '',
    category: warning.category || '',
    message: warning.message || '',
  }));
}

function parseErrorResult(
  response: { status: number; body: string },
  message: string,
  parseError: unknown,
): ZatcaSubmitResult {
  const error = {
    code: 'PARSE_ERROR',
    category: 'CLIENT',
    message: `${message}: ${parseError}`,
  };

  return {
    success: false,
    httpStatus: response.status,
    error,
    alerts: [{ severity: 'error', ...error }],
    rawBody: response.body,
  };
}

export function parseInvoiceListResponse(
  response: { status: number; body: string },
  data: any,
  options: Pick<SubmissionParseOptions, 'includeReportingStatus' | 'includeClearanceStatus'> = {},
): ZatcaSubmitResult | undefined {
  const accepted = data.acceptedInvoices?.[0] as RawInvoiceResult | undefined;
  const rejected = (data.rejectededInvoices?.[0] || data.rejectedInvoices?.[0]) as RawInvoiceResult | undefined;
  const invoice = accepted || rejected;

  if (!invoice) return undefined;

  const diagnostics = extractValidationDiagnostics(data.validationResults);
  const invoiceWarnings = normalizeInvoiceWarnings(invoice.warnings);
  const invoiceAlerts = invoiceWarnings.map((warning) => ({
    severity: 'warning' as const,
    code: warning.code,
    category: warning.category,
    message: warning.message,
  }));
  const invoiceError = normalizeInvoiceError(invoice.error);
  const error = invoiceError ?? diagnostics.error;

  return {
    success: !!accepted,
    httpStatus: response.status,
    error,
    alerts: [...diagnostics.alerts, ...invoiceAlerts],
    response: {
      uuid: invoice.uuid || '',
      invoiceHash: invoice.invoiceHash || '',
      clearedInvoice: invoice.clearedInvoice,
      clearanceDateTime: invoice.clearanceDateTime,
      clearanceStatus: options.includeClearanceStatus ? invoice.clearanceStatus : undefined,
      reportingStatus: options.includeReportingStatus ? invoice.reportingStatus : undefined,
      status: accepted ? 'ACCEPTED' : 'REJECTED',
      error,
      warnings: invoiceWarnings,
    },
    rawBody: response.body,
  };
}

export function parseSubmissionResponse(
  response: { status: number; body: string },
  options: SubmissionParseOptions,
  parseData: (data: any) => ZatcaSubmitResult | undefined,
): ZatcaSubmitResult {
  try {
    const data = JSON.parse(response.body);
    const parsed = parseData(data);

    return parsed ?? {
      success: response.status >= 200 && response.status < 300,
      httpStatus: response.status,
      rawBody: response.body,
    };
  } catch (parseError) {
    return parseErrorResult(response, options.parseErrorMessage, parseError);
  }
}
