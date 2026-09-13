/**
 * ZATCA Clearance API
 *
 * For standard (B2B) invoices. Synchronous — must be cleared before delivery.
 */

import { ZatcaHttpClient } from './client.js';
import type {
  ZatcaCredentials,
  SubmitInvoiceRequest,
  ZatcaSubmitResult,
} from '../types.js';
import { parseInvoiceListResponse, parseSubmissionResponse } from './submission-response.js';

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
    return parseSubmissionResponse(
      response,
      { parseErrorMessage: 'Failed to parse clearance response' },
      (data) => parseInvoiceListResponse(response, data, { includeClearanceStatus: true }),
    );
  }
}
