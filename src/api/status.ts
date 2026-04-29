/**
 * ZATCA Invoice Status API
 *
 * Check the status of a previously submitted invoice.
 */

import { ZatcaHttpClient } from './client.js';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type { ZatcaApiConfig, ZatcaCredentials } from '../types.js';

export interface InvoiceStatusResult {
  status: 'SUBMITTED' | 'IN_PROGRESS' | 'ACCEPTED' | 'REJECTED' | 'REPORTED' | 'CLEARED';
  validationResults?: {
    status: string;
    errorMessages: Array<{ code: string; message: string }>;
    warningMessages: Array<{ code: string; message: string }>;
    infoMessages: Array<{ code: string; message: string }>;
  };
  clearanceStatus?: string;
  reportingStatus?: string;
  raw: unknown;
}

export class StatusApi extends ZatcaHttpClient {
  /**
   * Check the status of a submitted invoice
   *
   * GET /invoices/status/{uuid}
   */
  async checkStatus(
    credentials: ZatcaCredentials,
    uuid: string,
  ): Promise<InvoiceStatusResult> {
    const response = await this.request(
      'GET',
      `/invoices/status/${uuid}`,
      undefined,
      credentials,
    );

    if (response.status === 404) {
      throw new ZatcaError(`Invoice not found: ${uuid}`, ZatcaErrorCode.API_ERROR);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new ZatcaError(
        `Failed to parse invoice status response (HTTP ${response.status}): ${response.body.substring(0, 200)}`,
        ZatcaErrorCode.API_ERROR,
        { httpStatus: response.status, body: response.body },
      );
    }

    return this.parseStatusResult(data);
  }

  /**
   * Check status by request ID (from submission response)
   *
   * GET /invoices/status/request/{requestId}
   */
  async checkByRequestId(
    credentials: ZatcaCredentials,
    requestId: string,
  ): Promise<InvoiceStatusResult> {
    const response = await this.request(
      'GET',
      `/invoices/status/request/${requestId}`,
      undefined,
      credentials,
    );

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new ZatcaError(
        `Failed to parse status response for request ${requestId} (HTTP ${response.status}): ${response.body.substring(0, 200)}`,
        ZatcaErrorCode.API_ERROR,
        { httpStatus: response.status, body: response.body },
      );
    }

    return this.parseStatusResult(data);
  }

  private parseStatusResult(data: Record<string, unknown>): InvoiceStatusResult {
    const validationResults = data.validationResults as
      | {
          status?: string;
          errorMessages?: Array<{ code: string; message: string }>;
          warningMessages?: Array<{ code: string; message: string }>;
          infoMessages?: Array<{ code: string; message: string }>;
        }
      | undefined;

    return {
      status: (data.status as InvoiceStatusResult['status']) || 'SUBMITTED',
      validationResults: validationResults
        ? {
            status: validationResults.status || '',
            errorMessages: validationResults.errorMessages || [],
            warningMessages: validationResults.warningMessages || [],
            infoMessages: validationResults.infoMessages || [],
          }
        : undefined,
      clearanceStatus: (data.clearanceStatus as string) || undefined,
      reportingStatus: (data.reportingStatus as string) || undefined,
      raw: data,
    };
  }
}
