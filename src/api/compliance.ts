/**
 * ZATCA Compliance CSID API
 *
 * Used during onboarding to obtain test credentials
 * and validate the EGS integration against ZATCA compliance checks.
 */

import { ZatcaHttpClient } from './client.js';
import type {
  ZatcaApiConfig,
  ZatcaCredentials,
  ZatcaCSIDResponse,
} from '../types.js';

export class ComplianceApi extends ZatcaHttpClient {
  /**
   * Request a Compliance CSID (test certificate)
   *
   * POST /compliance
   * Body: { csr: string } — Base64-encoded CSR
   */
  async requestCSID(csr: string): Promise<ZatcaCSIDResponse> {
    const response = await this.request('POST', '/compliance', { csr });

    const data = JSON.parse(response.body);

    return {
      binarySecurityToken: data.binarySecurityToken || '',
      secret: data.secret || '',
      requestId: data.requestID || data.requestId,
      status: response.status >= 200 && response.status < 300 ? 'ACCEPTED' : 'REJECTED',
      error: data.errors?.[0]
        ? {
            code: data.errors[0].code || '',
            category: data.errors[0].category || '',
            message: data.errors[0].message || '',
          }
        : undefined,
    };
  }

  /**
   * Verify a compliance certificate with CSID
   *
   * POST /compliance/invoices
   * Used to run compliance checks against sample invoices
   */
  async verifyCompliance(
    credentials: ZatcaCredentials,
    invoiceHash: string,
    uuid: string,
    invoice: string,
  ): Promise<{ valid: boolean; messages: string[] }> {
    const response = await this.request(
      'POST',
      '/compliance/invoices',
      { invoiceHash, uuid, invoice },
      credentials,
    );

    const data = JSON.parse(response.body);
    const errors: Array<{ message: string }> = data.validationResults?.errorMessages || [];
    const warnings: Array<{ message: string }> = data.validationResults?.warningMessages || [];

    return {
      valid: errors.length === 0,
      messages: [
        ...errors.map((e) => `ERROR: ${e.message}`),
        ...warnings.map((w) => `WARNING: ${w.message}`),
      ],
    };
  }

  /**
   * Request production CSID after passing compliance checks
   *
   * POST /production/csids
   * Body: { compliance_request_id: string }
   */
  async requestProductionCSID(
    credentials: ZatcaCredentials,
    complianceRequestId: string,
  ): Promise<ZatcaCSIDResponse> {
    const response = await this.request(
      'POST',
      '/production/csids',
      { compliance_request_id: complianceRequestId },
      credentials,
    );

    const data = JSON.parse(response.body);

    return {
      binarySecurityToken: data.binarySecurityToken || '',
      secret: data.secret || '',
      requestId: data.requestID || data.requestId,
      status: response.status >= 200 && response.status < 300 ? 'ACCEPTED' : 'REJECTED',
      error: data.errors?.[0]
        ? {
            code: data.errors[0].code || '',
            category: data.errors[0].category || '',
            message: data.errors[0].message || '',
          }
        : undefined,
    };
  }
}
