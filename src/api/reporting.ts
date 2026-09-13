/**
 * ZATCA Reporting API
 *
 * For simplified (B2C) invoices. Asynchronous — invoice must be reported within 24h.
 * Retry behavior is configurable via config.retryMax and config.retryBackoffMs.
 *
 * The retry loop runs as an Effect v4 workflow (`reportInvoiceEffect`, defined
 * here and re-exported through the `src/effect/index.ts` barrel): `Effect.retry`
 * over a jittered schedule, retrying transport failures and 5xx API responses
 * only; 4xx (non-429) and REJECTED responses are terminal results. The promise
 * method stays a thin wrapper with the exact legacy observable behavior.
 */

import { Effect } from 'effect';
import { ZatcaHttpClient } from './client.js';
import type {
  ZatcaApiConfig,
  ZatcaCredentials,
  SubmitInvoiceRequest,
  ZatcaSubmitResult,
} from '../types.js';
import { ZatcaErrorCode } from '../errors.js';
import { extractValidationDiagnostics } from './diagnostics.js';
import { parseInvoiceListResponse, parseSubmissionResponse } from './submission-response.js';
import { ZatcaApiError, runZatcaEffect, type ZatcaConnectionError, type ZatcaTimeoutError } from '../effect/errors.js';
import { retrySchedule, type RetryInfo, type RetryScheduleConfig } from '../effect/schedule.js';
import { ZatcaHttp, layerZatcaHttp, type ZatcaHttpLayerOptions, type ZatcaHttpRequest } from '../effect/http.js';

const REPORTING_PATH = '/invoices/reporting/single';

export interface ReportingRequestInput {
  baseUrl: string;
  credentials: ZatcaCredentials;
  request: SubmitInvoiceRequest;
  clearanceStatus: string;
}

/** Builds the transport descriptor for a reporting (B2C) submission. */
export const buildReportingRequest = (input: ReportingRequestInput): ZatcaHttpRequest => {
  const { baseUrl, credentials, request, clearanceStatus } = input;
  const auth = Buffer.from(
    `${credentials.binarySecurityToken}:${credentials.secret}`,
  ).toString('base64');

  return {
    method: 'POST',
    url: `${baseUrl}${REPORTING_PATH}`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'en',
      'Accept-Version': 'V2',
      'Clearance-Status': clearanceStatus,
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      invoiceHash: request.invoiceHash,
      uuid: request.uuid,
      invoice: request.invoice,
    }),
  };
};

/** A result the retry loop returns without retrying. */
const isTerminalReportingResult = (result: ZatcaSubmitResult): boolean =>
  result.success ||
  // Don't retry on client errors (4xx) except 429
  (result.httpStatus >= 400 && result.httpStatus < 500 && result.httpStatus !== 429) ||
  // Don't retry on ZATCA rejection
  result.response?.status === 'REJECTED';

function parseReportingResponse(response: {
  status: number;
  body: string;
}): ZatcaSubmitResult {
  return parseSubmissionResponse(
    response,
    { parseErrorMessage: 'Failed to parse ZATCA response' },
    (data) => {
      // Reporting API format
      const reportingStatus = data.reportingStatus;
      if (reportingStatus) {
        const isSuccess = reportingStatus === 'REPORTED';
        const diagnostics = extractValidationDiagnostics(data.validationResults);

        return {
          success: isSuccess,
          httpStatus: response.status,
          error: diagnostics.error,
          alerts: diagnostics.alerts,
          response: {
            uuid: data.uuid || '',
            invoiceHash: data.invoiceHash || '',
            reportingStatus,
            status: isSuccess ? 'ACCEPTED' : 'REJECTED',
            error: diagnostics.error,
            warnings: diagnostics.warnings,
          },
          rawBody: response.body,
        };
      }

      // Clearance API format (in case endpoint returns this shape)
      return parseInvoiceListResponse(response, data, { includeReportingStatus: true });
    },
  );
}

// ---- Effect twin ----

/**
 * One reporting attempt: performs the request, parses the outcome and keeps
 * non-terminal results in the error channel so the retry schedule governs
 * them. Status/body travel along for the final result.
 */
const reportAttempt = (
  req: ZatcaHttpRequest,
): Effect.Effect<ZatcaSubmitResult, ZatcaConnectionError | ZatcaTimeoutError | ZatcaApiError, ZatcaHttp> =>
  Effect.gen(function*() {
    const http = yield* ZatcaHttp;
    const response = yield* http.request(req);
    const result = parseReportingResponse(response);

    if (isTerminalReportingResult(result)) {
      return result;
    }

    return yield* new ZatcaApiError({
      status: result.httpStatus,
      body: result.rawBody ?? '',
      message: `ZATCA API error (HTTP ${result.httpStatus})`,
      code: ZatcaErrorCode.API_ERROR,
    });
  });

/**
 * Effect twin of `ReportingApi.reportInvoice`: retries transport failures and
 * 5xx API responses per the configured schedule (default 3 retries with
 * [5000, 30000, 300000] backoff). Connection/timeout errors remain in the
 * error channel; every API-level outcome is returned as a result.
 */
export const reportInvoiceEffect = (
  req: ZatcaHttpRequest,
  retryConfig: RetryScheduleConfig = {},
): Effect.Effect<ZatcaSubmitResult, ZatcaConnectionError | ZatcaTimeoutError, ZatcaHttp> => {
  const onRetry = (info: RetryInfo): void => {
    console.log(
      `[ZATCA] Reporting retry ${info.attempt}/${info.retryMax} after ${info.delayMs}ms`,
    );
  };

  const retried = Effect.retry(
    reportAttempt(req),
    retrySchedule(retryConfig, { onRetry }),
  );

  // Retries exhausted (or a non-retryable API error): surface the last
  // response as a result, exactly like the legacy loop did.
  return Effect.catchTag(retried, 'ZatcaApiError', (error) =>
    Effect.succeed(parseReportingResponse({ status: error.status ?? 0, body: error.body ?? '' })),
  );
};

/** Runs `reportInvoiceEffect` on the live `ZatcaHttp` layer, rethrowing `ZatcaError`. */
export const runReportInvoice = (
  req: ZatcaHttpRequest,
  retryConfig: RetryScheduleConfig = {},
  options: ZatcaHttpLayerOptions = {},
): Promise<ZatcaSubmitResult> =>
  runZatcaEffect(
    Effect.provide(reportInvoiceEffect(req, retryConfig), layerZatcaHttp(options)),
  );

export class ReportingApi extends ZatcaHttpClient {
  private readonly retryMax: number;
  private readonly retryBackoffMs: number[];

  constructor(config: ZatcaApiConfig) {
    super(config);
    this.retryMax = config.retryMax ?? 3;
    this.retryBackoffMs = config.retryBackoffMs ?? [5000, 30000, 300000];
  }

  /**
   * Report a simplified invoice (B2C)
   *
   * POST /invoices/reporting/single
   * Headers: Clearance-Status, Authorization (Basic)
   * Body: { invoiceHash, uuid, invoice }
   *
   * Runs the Effect retry workflow (transport failures + 5xx) and returns
   * the last API outcome as a result; connection/timeout failures throw the
   * original `ZatcaError` once the schedule is exhausted.
   */
  async reportInvoice(
    credentials: ZatcaCredentials,
    request: SubmitInvoiceRequest,
  ): Promise<ZatcaSubmitResult> {
    const descriptor = buildReportingRequest({
      baseUrl: this.baseUrl,
      credentials,
      request,
      clearanceStatus: this.getClearanceStatus(),
    });
    return runReportInvoice(
      descriptor,
      { retryMax: this.retryMax, retryBackoffMs: this.retryBackoffMs },
      { timeoutMs: this.timeout },
    );
  }
}
