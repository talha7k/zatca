/**
 * Validation utilities for ZATCA invoice and certificate data
 */

import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type { InvoiceData, CSRParams, ZatcaCredentials, ZatcaApiConfig } from '../types.js';

/**
 * Validate invoice data before XML generation or submission
 */
export function validateInvoice(invoice: InvoiceData): void {
  const errors: string[] = [];

  if (!invoice.invoiceNumber) errors.push('invoiceNumber is required');
  if (!invoice.uuid) errors.push('uuid is required');
  if (!invoice.issueDate) errors.push('issueDate is required');
  if (!invoice.issueTime) errors.push('issueTime is required');
  if (!invoice.invoiceTypeCode) errors.push('invoiceTypeCode is required');
  if (!invoice.currencyCode) errors.push('currencyCode is required');

  // Supplier validation
  if (!invoice.supplier?.nameAr) errors.push('supplier.nameAr is required');
  if (!invoice.supplier?.nameEn) errors.push('supplier.nameEn is required');
  if (!invoice.supplier?.vatNumber) errors.push('supplier.vatNumber is required');
  if (invoice.supplier?.vatNumber && invoice.supplier.vatNumber.length !== 15) {
    errors.push('supplier.vatNumber must be 15 digits');
  }

  // Address validation
  if (!invoice.supplier?.address?.city) errors.push('supplier.address.city is required');
  if (!invoice.supplier?.address?.street) errors.push('supplier.address.street is required');
  if (!invoice.supplier?.address?.postalCode) errors.push('supplier.address.postalCode is required');

  // Amounts
  if (invoice.taxAmount < 0) errors.push('taxAmount must be non-negative');
  if (invoice.payableAmount < 0) errors.push('payableAmount must be non-negative');

  // Line items
  if (!invoice.invoiceLines?.length) errors.push('At least one invoice line is required');

  if (errors.length > 0) {
    throw new ZatcaError(
      `Invoice validation failed: ${errors.join('; ')}`,
      ZatcaErrorCode.VALIDATION_ERROR,
      { errors },
    );
  }
}

/**
 * Validate CSR parameters before certificate generation
 */
export function validateCSRParams(params: CSRParams): void {
  const errors: string[] = [];

  if (!params.organizationNameAr) errors.push('organizationNameAr is required');
  if (!params.organizationNameEn) errors.push('organizationNameEn is required');
  if (!params.vatNumber) errors.push('vatNumber is required');
  if (params.vatNumber.length !== 15) errors.push('vatNumber must be 15 digits');
  if (!params.crNumber) errors.push('crNumber is required');
  if (!params.commonName) errors.push('commonName is required');
  if (!params.egsSerialNumber) errors.push('egsSerialNumber is required');

  if (!params.location?.city) errors.push('location.city is required');
  if (!params.location?.district) errors.push('location.district is required');
  if (!params.location?.street) errors.push('location.street is required');
  if (!params.location?.buildingNumber) errors.push('location.buildingNumber is required');
  if (!params.location?.postalCode) errors.push('location.postalCode is required');

  if (errors.length > 0) {
    throw new ZatcaError(
      `CSR validation failed: ${errors.join('; ')}`,
      ZatcaErrorCode.VALIDATION_ERROR,
      { errors },
    );
  }
}

/**
 * Validate ZATCA API credentials
 */
export function validateCredentials(credentials: ZatcaCredentials): void {
  if (!credentials.binarySecurityToken) {
    throw new ZatcaError('binarySecurityToken is required', ZatcaErrorCode.VALIDATION_ERROR);
  }
  if (!credentials.secret) {
    throw new ZatcaError('secret is required', ZatcaErrorCode.VALIDATION_ERROR);
  }
}

/**
 * Validate API configuration
 */
export function validateApiConfig(config: ZatcaApiConfig): void {
  if (!config.environment || !['sandbox', 'production'].includes(config.environment)) {
    throw new ZatcaError('environment must be "sandbox" or "production"', ZatcaErrorCode.VALIDATION_ERROR);
  }
}
