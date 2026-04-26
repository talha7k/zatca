/**
 * ZATCA Fatoora API — Unified Client
 *
 * Provides all ZATCA API operations in a single class:
 * - Compliance CSID management (onboarding)
 * - Invoice reporting (B2C)
 * - Invoice clearance (B2B)
 * - Invoice status checking
 */

export { ZatcaHttpClient } from './client.js';
export { ComplianceApi } from './compliance.js';
export { ReportingApi } from './reporting.js';
export { ClearanceApi } from './clearance.js';
export { StatusApi } from './status.js';
export type { InvoiceStatusResult } from './status.js';

import { ZatcaHttpClient } from './client.js';
import { ComplianceApi } from './compliance.js';
import { ReportingApi } from './reporting.js';
import { ClearanceApi } from './clearance.js';
import { StatusApi } from './status.js';
import type {
  ZatcaApiConfig,
  ZatcaCredentials,
  SubmitInvoiceRequest,
  ZatcaSubmitResult,
} from '../types.js';

export class ZatcaApiClient extends ZatcaHttpClient {
  private readonly compliance: ComplianceApi;
  private readonly reporting: ReportingApi;
  private readonly clearance: ClearanceApi;
  private readonly status: StatusApi;

  constructor(config: ZatcaApiConfig) {
    super(config);
    this.compliance = new ComplianceApi(config);
    this.reporting = new ReportingApi(config);
    this.clearance = new ClearanceApi(config);
    this.status = new StatusApi(config);
  }

  // ---- Compliance ----

  async requestComplianceCSID(csr: string) {
    return this.compliance.requestCSID(csr);
  }

  async verifyCompliance(
    credentials: ZatcaCredentials,
    invoiceHash: string,
    uuid: string,
    invoice: string,
  ) {
    return this.compliance.verifyCompliance(credentials, invoiceHash, uuid, invoice);
  }

  async requestProductionCSID(
    credentials: ZatcaCredentials,
    complianceRequestId: string,
  ) {
    return this.compliance.requestProductionCSID(credentials, complianceRequestId);
  }

  // ---- Reporting (B2C) ----

  async submitForReporting(
    credentials: ZatcaCredentials,
    request: SubmitInvoiceRequest,
  ): Promise<ZatcaSubmitResult> {
    return this.reporting.reportInvoice(credentials, request);
  }

  // ---- Clearance (B2B) ----

  async submitForClearance(
    credentials: ZatcaCredentials,
    request: SubmitInvoiceRequest,
  ): Promise<ZatcaSubmitResult> {
    return this.clearance.clearInvoice(credentials, request);
  }

  // ---- Status ----

  async checkInvoiceStatus(credentials: ZatcaCredentials, uuid: string) {
    return this.status.checkStatus(credentials, uuid);
  }

  async checkByRequestId(credentials: ZatcaCredentials, requestId: string) {
    return this.status.checkByRequestId(credentials, requestId);
  }
}
