/**
 * ZATCA Clearance API
 *
 * For standard (B2B) invoices. Synchronous — must be cleared before delivery.
 */

import { Effect } from 'effect';
import { ZatcaHttpClient } from './client.js';
import type {
  ZatcaCredentials,
  SubmitInvoiceRequest,
  ZatcaSubmitResult,
} from '../types.js';
import { parseInvoiceListResponse, parseSubmissionResponse } from './submission-response.js';
import { toZatcaEffectError, type ZatcaEffectError } from '../effect/errors.js';

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

  /**
   * Effect twin of {@link clearInvoice}: same endpoint, headers, body, and
   * result, with transport failures surfaced in the typed error channel as
   * ZatcaConnectionError / ZatcaTimeoutError / ZatcaApiError. Unparseable
   * responses stay successful results with `success: false`, matching the
   * promise version.
   */
  readonly clearInvoiceEffect = Effect.fn('ClearanceApi.clearInvoiceEffect')(
    function* (
      this: ClearanceApi,
      credentials: ZatcaCredentials,
      request: SubmitInvoiceRequest,
    ): Effect.fn.Return<ZatcaSubmitResult, ZatcaEffectError> {
      const response = yield* Effect.tryPromise({
        try: () =>
          this.request(
            'POST',
            '/invoices/clearance/single',
            {
              invoiceHash: request.invoiceHash,
              uuid: request.uuid,
              invoice: request.invoice,
            },
            credentials,
            { 'Clearance-Status': this.getClearanceStatus() },
          ),
        catch: toZatcaEffectError,
      });

      return yield* Effect.try({
        try: () => this.parseClearanceResponse(response),
        catch: toZatcaEffectError,
      });
    },
  );

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
