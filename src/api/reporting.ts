/**
 * ZATCA Reporting API
 *
 * For simplified (B2C) invoices. Asynchronous — invoice must be reported within 24h.
 * Includes automatic retry with exponential backoff for transient failures.
 */

import { ZatcaHttpClient } from './client.js';
import type {
  ZatcaApiConfig,
  ZatcaCredentials,
  SubmitInvoiceRequest,
  ZatcaSubmitResult,
} from '../types.js';
import { extractValidationDiagnostics } from './diagnostics.js';
import { parseInvoiceListResponse, parseSubmissionResponse } from './submission-response.js';

export class ReportingApi extends ZatcaHttpClient {
  private readonly retryMax: number;
  private readonly retryBackoffMs: number[];

  constructor(config: ZatcaApiConfig) {
    super(config);
    this.retryMax = 3;
    this.retryBackoffMs = [5000, 30000, 300000];
  }

  /**
   * Report a simplified invoice (B2C)
   *
   * POST /invoices/reporting/single
   * Headers: Clearance-Status, Authorization (Basic)
   * Body: { invoiceHash, uuid, invoice }
   */
  async reportInvoice(
    credentials: ZatcaCredentials,
    request: SubmitInvoiceRequest,
  ): Promise<ZatcaSubmitResult> {
    let lastResult: ZatcaSubmitResult | null = null;

    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      if (attempt > 0) {
        const backoff =
          this.retryBackoffMs[Math.min(attempt - 1, this.retryBackoffMs.length - 1)];
        console.log(
          `[ZATCA] Reporting retry ${attempt}/${this.retryMax} after ${backoff}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }

      const result = await this.doReport(credentials, request);
      lastResult = result;

      if (result.success) return result;

      // Don't retry on client errors (4xx) except 429
      if (
        result.httpStatus >= 400 &&
        result.httpStatus < 500 &&
        result.httpStatus !== 429
      ) {
        return result;
      }

      // Don't retry on ZATCA rejection
      if (result.response?.status === 'REJECTED') {
        return result;
      }
    }

    return lastResult!;
  }

  private async doReport(
    credentials: ZatcaCredentials,
    request: SubmitInvoiceRequest,
  ): Promise<ZatcaSubmitResult> {
    const response = await this.request(
      'POST',
      '/invoices/reporting/single',
      {
        invoiceHash: request.invoiceHash,
        uuid: request.uuid,
        invoice: request.invoice,
      },
      credentials,
      { 'Clearance-Status': this.getClearanceStatus() },
    );

    return this.parseResponse(response);
  }

  private parseResponse(response: { status: number; body: string }): ZatcaSubmitResult {
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
}
