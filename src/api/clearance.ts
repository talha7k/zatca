/**
 * ZATCA Clearance API
 *
 * For standard (B2B) invoices. Synchronous — must be cleared before delivery.
 */

import { ZatcaHttpClient } from './client.js';
import type {
  ZatcaApiConfig,
  ZatcaCredentials,
  SubmitInvoiceRequest,
  ZatcaSubmitResult,
} from '../types.js';

export class ClearanceApi extends ZatcaHttpClient {
  /**
   * Clear a standard invoice (B2B)
   *
   * POST /invoices/clearance/single
   * Headers: Clearance-Status, Authorization (Basic)
   * Body: { invoiceHash, uuid, invoice }
   */
  async clearInvoice(
    credentials: ZatcaCredentials,
    request: SubmitInvoiceRequest,
  ): Promise<ZatcaSubmitResult> {
    const response = await this.request(
      'POST',
      '/invoices/clearance/single',
      {
        invoiceHash: request.invoiceHash,
        uuid: request.uuid,
        invoice: request.invoice,
      },
      credentials,
      { 'Clearance-Status': this.getClearanceStatus() },
    );

    return this.parseClearanceResponse(response);
  }

  private parseClearanceResponse(
    response: { status: number; body: string },
  ): ZatcaSubmitResult {
    try {
      const data = JSON.parse(response.body);

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
            clearanceStatus: invoice.clearanceStatus,
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
          message: `Failed to parse clearance response: ${parseError}`,
        },
        rawBody: response.body,
      };
    }
  }
}
