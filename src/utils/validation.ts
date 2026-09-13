/**
 * Validation utilities for ZATCA invoice and certificate data
 *
 * Each exported validator aggregates the results of small, single-section
 * pure helpers. The helpers return their findings as message arrays so the
 * original error semantics are preserved exactly: one ZatcaError per
 * validator, messages joined with "; ", in stable check order.
 */

import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { isNegative } from './money.js';
import type { AllowanceCharge, InvoiceData, CSRParams, ZatcaCredentials, ZatcaApiConfig } from '../types.js';

// ============================================================
// Shared aggregation
// ============================================================

/**
 * Throw the aggregated validation error for a validation scope.
 *
 * Message format: `<scope> validation failed: <error 1>; <error 2>; ...`
 * with the individual messages also exposed via `details.errors`.
 */
function throwValidationErrors(scope: string, errors: string[]): never {
  throw new ZatcaError(
    `${scope} validation failed: ${errors.join('; ')}`,
    ZatcaErrorCode.VALIDATION_ERROR,
    { errors },
  );
}

/** Errors for a list of allowance charges, using the given message prefix. */
function allowanceChargeErrors(charges: AllowanceCharge[] | undefined, errorPrefix: string): string[] {
  const errors: string[] = [];
  for (const charge of charges ?? []) {
    if (!charge.reason) errors.push(`${errorPrefix}.reason is required`);
    if (charge.amount != null && isNegative(charge.amount)) errors.push(`${errorPrefix}.amount must be non-negative`);
  }
  return errors;
}

// ============================================================
// Invoice section validators (order defines error order)
// ============================================================

/** Required identification fields: number, uuid, dates, type and currency codes. */
function requiredHeaderFieldErrors(invoice: InvoiceData): string[] {
  const errors: string[] = [];
  if (!invoice.invoiceNumber) errors.push('invoiceNumber is required');
  if (!invoice.uuid) errors.push('uuid is required');
  if (!invoice.issueDate) errors.push('issueDate is required');
  if (!invoice.issueTime) errors.push('issueTime is required');
  if (!invoice.invoiceTypeCode) errors.push('invoiceTypeCode is required');
  if (!invoice.currencyCode) errors.push('currencyCode is required');
  return errors;
}

/** The ZATCA supplier VAT number is exactly 15 digits (only checked when present). */
function vatNumberFormatErrors(vatNumber: string | undefined): string[] {
  const errors: string[] = [];
  if (vatNumber && vatNumber.length !== 15) {
    errors.push('supplier.vatNumber must be 15 digits');
  }
  return errors;
}

/** Required supplier identity fields, plus the 15-digit VAT check. */
function supplierIdentityErrors(invoice: InvoiceData): string[] {
  const errors: string[] = [];
  if (!invoice.supplier?.nameAr) errors.push('supplier.nameAr is required');
  if (!invoice.supplier?.nameEn) errors.push('supplier.nameEn is required');
  if (!invoice.supplier?.vatNumber) errors.push('supplier.vatNumber is required');
  errors.push(...vatNumberFormatErrors(invoice.supplier?.vatNumber));
  return errors;
}

const REQUIRED_ADDRESS_FIELDS = ['city', 'street', 'postalCode'] as const;

/** Required supplier address fields. */
function supplierAddressErrors(invoice: InvoiceData): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_ADDRESS_FIELDS) {
    if (!invoice.supplier?.address?.[field]) errors.push(`supplier.address.${field} is required`);
  }
  return errors;
}

/** Required totals, then non-negative totals and invoice-level allowance charges. */
function amountErrors(invoice: InvoiceData): string[] {
  const errors: string[] = [];
  // Required checks (`== null` covers undefined and null) must come BEFORE the
  // negativity checks — zero is a valid total, so truthiness is not used here.
  if (invoice.taxAmount == null) errors.push('taxAmount is required');
  if (invoice.payableAmount == null) errors.push('payableAmount is required');
  if (invoice.taxAmount != null && isNegative(invoice.taxAmount)) errors.push('taxAmount must be non-negative');
  if (invoice.payableAmount != null && isNegative(invoice.payableAmount)) errors.push('payableAmount must be non-negative');
  errors.push(...allowanceChargeErrors(invoice.allowanceCharges, 'allowanceCharges'));
  return errors;
}

/** At least one line, and valid allowance charges on every line. */
function lineItemErrors(invoice: InvoiceData): string[] {
  const errors: string[] = [];
  if (!invoice.invoiceLines?.length) errors.push('At least one invoice line is required');
  for (const line of invoice.invoiceLines ?? []) {
    errors.push(...allowanceChargeErrors(line.allowanceCharges, 'invoiceLines.allowanceCharges'));
  }
  return errors;
}

/**
 * Validate invoice data before XML generation or submission
 */
export function validateInvoice(invoice: InvoiceData): void {
  const errors = [
    ...requiredHeaderFieldErrors(invoice),
    ...supplierIdentityErrors(invoice),
    ...supplierAddressErrors(invoice),
    ...amountErrors(invoice),
    ...lineItemErrors(invoice),
  ];
  if (errors.length > 0) throwValidationErrors('Invoice', errors);
}

// ============================================================
// CSR parameter validators (order defines error order)
// ============================================================

/**
 * The CSR VAT number is exactly 15 digits (only checked when present), with
 * the required error when missing — mirroring the invoice supplier check.
 */
function csrVatNumberErrors(vatNumber: string | undefined): string[] {
  const errors: string[] = [];
  if (!vatNumber) errors.push('vatNumber is required');
  if (vatNumber && vatNumber.length !== 15) errors.push('vatNumber must be 15 digits');
  return errors;
}

/** Required CSR identity fields, plus the 15-digit VAT check. */
function csrRequiredFieldErrors(params: CSRParams): string[] {
  const errors: string[] = [];
  if (!params.organizationNameAr) errors.push('organizationNameAr is required');
  if (!params.organizationNameEn) errors.push('organizationNameEn is required');
  errors.push(...csrVatNumberErrors(params.vatNumber));
  if (!params.crNumber) errors.push('crNumber is required');
  if (!params.commonName) errors.push('commonName is required');
  if (!params.egsSerialNumber) errors.push('egsSerialNumber is required');
  return errors;
}

const REQUIRED_LOCATION_FIELDS = [
  'city',
  'district',
  'street',
  'buildingNumber',
  'postalCode',
] as const;

/** Required CSR location fields. */
function csrLocationErrors(params: CSRParams): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_LOCATION_FIELDS) {
    if (!params.location?.[field]) errors.push(`location.${field} is required`);
  }
  return errors;
}

/**
 * Validate CSR parameters before certificate generation
 */
export function validateCSRParams(params: CSRParams): void {
  const errors = [
    ...csrRequiredFieldErrors(params),
    ...csrLocationErrors(params),
  ];
  if (errors.length > 0) throwValidationErrors('CSR', errors);
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
