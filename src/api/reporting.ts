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
    try {
      const data = JSON.parse(response.body);

      // Reporting API format
      const reportingStatus = data.reportingStatus;
      if (reportingStatus) {
        const isSuccess = reportingStatus === 'REPORTED';
        const errors: Array<{ message: string; code?: string; category?: string }> =
          data.validationResults?.errorMessages || [];
        const warnings: Array<{ message: string; code?: string; category?: string }> =
          data.validationResults?.warningMessages || [];

        return {
          success: isSuccess,
          httpStatus: response.status,
          response: {
            uuid: data.uuid || '',
            invoiceHash: data.invoiceHash || '',
            reportingStatus,
            status: isSuccess ? 'ACCEPTED' : 'REJECTED',
            error:
              errors.length > 0
                ? {
                    code: errors[0].code || '',
                    category: errors[0].category || '',
                    message: errors.map((e) => e.message).join('; '),
                  }
                : undefined,
            warnings: warnings.map((w) => ({
              code: w.code || '',
              category: w.category || '',
              message: w.message || '',
            })),
          },
          rawBody: response.body,
        };
      }

      // Clearance API format (in case endpoint returns this shape)
      const accepted = data.acceptedInvoices?.[0];
      const rejected = data.rejectededInvoices?.[0] || data.rejectedInvoices?.[0];
      const invoice = accepted || rejected;

      if (invoice) {
        return {
          success: !!accepted,
          httpStatus: response.status,
          response: {
            uuid: invoice.uuid || '',
            invoiceHash: invoice.invoiceHash || '',
            clearedInvoice: invoice.clearedInvoice,
            clearanceDateTime: invoice.clearanceDateTime,
            reportingStatus: invoice.reportingStatus,
            status: !!accepted ? 'ACCEPTED' : 'REJECTED',
            error: invoice.error
              ? {
                  code: invoice.error.code || '',
                  category: invoice.error.category || '',
                  message: invoice.error.message || '',
                }
              : undefined,
            warnings: (invoice.warnings || []).map(
              (w: { code?: string; category?: string; message?: string }) => ({
                code: w.code || '',
                category: w.category || '',
                message: w.message || '',
              }),
            ),
          },
          rawBody: response.body,
        };
      }

      // Fallback — treat HTTP status as success indicator
      return {
        success: response.status >= 200 && response.status < 300,
        httpStatus: response.status,
        rawBody: response.body,
      };
    } catch (parseError) {
      return {
        success: false,
        httpStatus: response.status,
        error: {
          code: 'PARSE_ERROR',
          category: 'CLIENT',
          message: `Failed to parse ZATCA response: ${parseError}`,
        },
        rawBody: response.body,
      };
    }
  }
}
