/**
 * ZATCA Compliance CSID API
 *
 * Used during onboarding to obtain test credentials
 * and validate the EGS integration against ZATCA compliance checks.
 */

import { Effect } from 'effect';
import { ZatcaHttpClient } from './client.js';
import type {
  ZatcaCredentials,
  ZatcaCSIDResponse,
} from '../types.js';
import { toZatcaEffectError, runZatcaEffect, type ZatcaEffectError } from '../effect/errors.js';

function rejectedCsid(code: string, message: string): ZatcaCSIDResponse {
  return {
    binarySecurityToken: '',
    secret: '',
    requestId: undefined,
    status: 'REJECTED',
    error: {
      code,
      category: code.startsWith('HTTP_') ? 'HTTP-Errors' : 'VALIDATION',
      message,
    },
  };
}

function requestIdFrom(data: ReturnType<typeof JSON.parse>): string | undefined {
  if (data.requestID != null) return String(data.requestID);
  if (data.requestId != null) return String(data.requestId);
  return undefined;
}

function parseCsidResponse(response: { status: number; body: string }): ZatcaCSIDResponse {
  let data: ReturnType<typeof JSON.parse>;
  try {
    data = JSON.parse(response.body);
  } catch {
    return rejectedCsid(`HTTP_${response.status}`, response.body);
  }

  return {
    binarySecurityToken: data.binarySecurityToken || '',
    secret: data.secret || '',
    requestId: requestIdFrom(data),
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

export class ComplianceApi extends ZatcaHttpClient {
  /**
   * Request a Compliance CSID (test certificate)
   *
   * POST /compliance
   * Body: { csr: string } — Base64-encoded CSR
   *
   * When `otp` is provided, uses OTP header instead of Basic Auth.
   * This is required for the /compliance endpoint.
   */
  requestCSID(csr: string, otp?: string): Promise<ZatcaCSIDResponse> {
    return runZatcaEffect(this.requestCSIDEffect(csr, otp));
  }

  /**
   * Effect twin of {@link requestCSID}: same endpoint, headers, and result.
   * Local rejections (missing CSR, CSR encoding) stay successful REJECTED
   * responses, matching the promise version; transport failures surface as
   * ZatcaConnectionError / ZatcaTimeoutError / ZatcaApiError.
   */
  readonly requestCSIDEffect = Effect.fn('ComplianceApi.requestCSIDEffect')(
    function* (this: ComplianceApi, csr: string, otp?: string): Effect.fn.Return<ZatcaCSIDResponse, ZatcaEffectError> {
      if (!csr) {
        return rejectedCsid('MISSING_CSR', 'CSR is required to request a Compliance CSID');
      }

      let csrBase64: string;
      try {
        csrBase64 = btoa(csr);
      } catch {
        return rejectedCsid(
          'CSR_ENCODING_ERROR',
          'Failed to Base64-encode the CSR. Ensure it is a valid PEM string.',
        );
      }

      const response = yield* Effect.tryPromise({
        try: () => this.request('POST', '/compliance', { csr: csrBase64 }, undefined, undefined, otp),
        catch: toZatcaEffectError,
      });
      return parseCsidResponse(response);
    },
  );

  /**
   * Verify a compliance certificate with CSID
   *
   * POST /compliance/invoices
   * Used to run compliance checks against sample invoices
   */
  verifyCompliance(
    credentials: ZatcaCredentials,
    invoiceHash: string,
    uuid: string,
    invoice: string,
  ): Promise<{ valid: boolean; messages: string[] }> {
    return runZatcaEffect(this.verifyComplianceEffect(credentials, invoiceHash, uuid, invoice));
  }

  /**
   * Effect twin of {@link verifyCompliance}: same endpoint and result.
   * Unparseable responses stay successful results with `valid: false`,
   * matching the promise version; transport failures surface in the typed
   * error channel.
   */
  readonly verifyComplianceEffect = Effect.fn('ComplianceApi.verifyComplianceEffect')(
    function* (
      this: ComplianceApi,
      credentials: ZatcaCredentials,
      invoiceHash: string,
      uuid: string,
      invoice: string,
    ): Effect.fn.Return<{ valid: boolean; messages: Array<string> }, ZatcaEffectError> {
      const response = yield* Effect.tryPromise({
        try: () =>
          this.request(
            'POST',
            '/compliance/invoices',
            { invoiceHash, uuid, invoice },
            credentials,
          ),
        catch: toZatcaEffectError,
      });

      let data: ReturnType<typeof JSON.parse>;
      try {
        data = JSON.parse(response.body);
      } catch {
        return {
          valid: false,
          messages: [`HTTP ${response.status}: ${response.body}`],
        };
      }

      const errors: Array<{ message: string }> = data.validationResults?.errorMessages || [];
      const warnings: Array<{ message: string }> = data.validationResults?.warningMessages || [];

      return {
        valid: errors.length === 0,
        messages: [
          ...errors.map((e) => `ERROR: ${e.message}`),
          ...warnings.map((w) => `WARNING: ${w.message}`),
        ],
      };
    },
  );

  /**
   * Request production CSID after passing compliance checks
   *
   * POST /production/csids
   * Body: { compliance_request_id: string }
   */
  requestProductionCSID(
    credentials: ZatcaCredentials,
    complianceRequestId: string,
  ): Promise<ZatcaCSIDResponse> {
    return runZatcaEffect(this.requestProductionCSIDEffect(credentials, complianceRequestId));
  }

  /**
   * Effect twin of {@link requestProductionCSID}: same endpoint and result.
   * Non-2xx responses stay successful REJECTED results, matching the promise
   * version; transport failures surface in the typed error channel.
   */
  readonly requestProductionCSIDEffect = Effect.fn('ComplianceApi.requestProductionCSIDEffect')(
    function* (
      this: ComplianceApi,
      credentials: ZatcaCredentials,
      complianceRequestId: string,
    ): Effect.fn.Return<ZatcaCSIDResponse, ZatcaEffectError> {
      const response = yield* Effect.tryPromise({
        try: () =>
          this.request(
            'POST',
            '/production/csids',
            { compliance_request_id: complianceRequestId },
            credentials,
          ),
        catch: toZatcaEffectError,
      });
      return parseCsidResponse(response);
    },
  );
}
