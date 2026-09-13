/**
 * ZATCA Phase 2 Types
 */

// ---- Environment ----

export type ZatcaEnvironment = 'sandbox' | 'production';

// ---- Invoice Types ----

export type InvoiceTypeCode = '388' | '381' | '383';
// 388 = Tax Invoice (standard or simplified, differentiated by InvoiceTypeCodeName)
// 381 = Credit Note
// 383 = Debit Note

export type InvoiceTypeCodeName =
  | '0100000'  // Standard document (B2B) — clearance
  | '0200000'; // Simplified document (B2C) — reporting

export type TaxCategoryId = 'S' | 'Z' | 'E' | 'O' | 'AE';
// S = Standard rated
// Z = Zero rated
// E = Exempt
// O = Out of scope
// AE = Reverse charge

import type { DecimalInput } from './utils/money.js';

export type ProfileId = 'reporting:1.0' | 'clearance:1.0';
export type { DecimalInput };

export type SubmissionType = 'CLEARANCE' | 'REPORTING';

export interface PostalAddress {
  street: string;
  building: string;
  /** KSA-23 — seller address additional number (4 digits). Emitted as cbc:PlotIdentification. Required by BR-KSA-09/BR-KSA-64 for the seller. */
  additionalNumber?: string;
  district: string;
  /** BT-80 country subentity (region) — BR-KSA-10's assert requires cbc:CountrySubentity on buyer addresses (not stated in its message). */
  countrySubentity?: string;
  city: string;
  postalCode: string;
  countryCode: string; // ISO 3166-1 alpha-2, e.g. "SA"
}

export interface SupplierInfo {
  nameAr: string;
  nameEn: string;
  vatNumber: string; // 15-digit TRN
  crNumber?: string; // Commercial Registration number
  address: PostalAddress;
}

export interface CustomerInfo {
  name: string;
  vatNumber: string;
  address?: PostalAddress;
}

export interface TaxSubtotal {
  /**
   * BT-116 — VAT category taxable amount. This is the SOLE source of truth
   * for taxable amounts (XML-IG §9.6): there is deliberately no top-level
   * `taxableAmount` on InvoiceData; BT-109 (taxExclusiveAmount) fills the
   * document-level role and BT-116 lives per VAT category here.
   */
  taxableAmount: DecimalInput;
  taxAmount: DecimalInput;
  percent: number;
  taxCategoryId: TaxCategoryId;
}

export interface AllowanceCharge {
  chargeIndicator: boolean;
  reason: string;
  amount: DecimalInput;
  taxCategoryId?: TaxCategoryId;
  taxPercent?: number;
}

export interface InvoiceLineItem {
  id: number;
  /** BT-129 — quantity; unrestricted decimals (string input is exact). */
  quantity: DecimalInput;
  unitCode: string; // UN/ECE Rec 20, e.g. "C62" (unit), "EA" (each)
  lineExtensionAmount: DecimalInput;
  taxAmount: DecimalInput;
  itemName: string;
  taxCategoryId: TaxCategoryId;
  taxPercent: number;
  /** BT-146 — unit price; unrestricted decimals (string input is exact). */
  priceAmount: DecimalInput;
  allowanceCharges?: AllowanceCharge[];
}

export interface InvoiceData {
  // Identification
  invoiceNumber: string;
  uuid: string;
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:MM:SS
  invoiceTypeCode: InvoiceTypeCode;
  invoiceTypeCodeName: InvoiceTypeCodeName;
  profileId: ProfileId;
  currencyCode: string;

  // Counter
  invoiceCounter?: number; // ICV — monotonic counter
  /** KSA-5 supply date (YYYY-MM-DD) — BR-KSA-15 requires it on standard (B2B) tax invoices. Emitted as cac:Delivery/cbc:ActualDeliveryDate. */
  supplyDate?: string;
  /** BT-81 payment means code — BR-KSA-16 requires one of 10/30/42/48/1 on standard (B2B) invoices. */
  paymentMeansCode?: number;
  previousInvoiceHash?: string; // PIH — hash chain

  // Parties
  supplier: SupplierInfo;
  customer?: CustomerInfo;

  // Totals — accept number | string (xs:decimal lexical strings are the
  // exact, preferred form; floats are converted at the shortest round-trip).
  lineExtensionAmount: DecimalInput;
  taxExclusiveAmount: DecimalInput;
  taxInclusiveAmount: DecimalInput;
  allowanceTotalAmount?: DecimalInput;
  allowanceCharges?: AllowanceCharge[];
  /** BT-113 — prepaid amount (BR-CO-16: BT-115 = BT-112 − BT-113 + BT-114). */
  prepaidAmount?: DecimalInput;
  /** BT-114 — document-level rounding amount; QR tag 4 carries the resulting BT-115 (payableAmount). */
  roundingAmount?: DecimalInput;
  payableAmount: DecimalInput;
  taxAmount: DecimalInput;

  // Tax breakdown
  taxSubtotals: TaxSubtotal[];

  // Line items
  invoiceLines: InvoiceLineItem[];
}

export interface CreditNoteData extends InvoiceData {
  originalInvoiceNumber: string;
  originalInvoiceUuid: string;
  originalInvoiceDate: string;
  reason: string;
}

export type ZatcaDocumentData = InvoiceData | CreditNoteData;

// ---- API Types ----

export interface ZatcaCredentials {
  binarySecurityToken: string;
  secret: string;
}

export interface ZatcaApiConfig {
  environment: ZatcaEnvironment;
  sandboxUrl?: string;
  productionUrl?: string;
  timeout?: number;
  retryMax?: number;
  retryBackoffMs?: number[];
  clearanceStatus?: '0' | '1';
}

export interface SubmitInvoiceRequest {
  invoiceHash: string;
  uuid: string;
  invoice: string; // Base64-encoded signed UBL 2.1 XML
}

export interface ZatcaSubmitResult {
  success: boolean;
  response?: ZatcaInvoiceResponse;
  error?: ZatcaApiError;
  alerts?: ZatcaSubmissionAlert[];
  httpStatus: number;
  rawBody?: string;
}

export interface ZatcaInvoiceResponse {
  reportingStatus?: string;
  clearanceStatus?: string;
  uuid: string;
  invoiceHash: string;
  clearedInvoice?: string;
  clearanceDateTime?: string;
  status: 'ACCEPTED' | 'REJECTED';
  error?: ZatcaApiError;
  warnings?: ZatcaApiWarning[];
}

export interface ZatcaCSIDResponse {
  binarySecurityToken: string;
  secret: string;
  requestId?: string;
  status: 'ACCEPTED' | 'REJECTED';
  error?: ZatcaApiError;
}

export interface ZatcaApiError {
  code: string;
  category: string;
  message: string;
  details?: string;
}

export interface ZatcaApiWarning {
  code: string;
  category: string;
  message: string;
}

export interface ZatcaSubmissionAlert {
  severity: 'error' | 'warning';
  code: string;
  category: string;
  message: string;
}

// ---- Certificate Types ----

export interface CSRParams {
  organizationNameAr: string;
  organizationNameEn: string;
  vatNumber: string;
  crNumber: string;
  country: string;
  commonName: string;
  invoiceType: string;
  businessCategory?: string; // e.g. 'Technology', 'Food', 'Supply activities'
  location: {
    city: string;
    district: string;
    street: string;
    buildingNumber: string;
    postalCode: string;
  };
  egsSerialNumber: string;
}

export interface CSRResult {
  csr: string; // PEM-encoded CSR
  privateKey: string; // PEM-encoded private key
  publicKey: string; // PEM-encoded public key
}

// ---- QR Types ----

export interface Phase1QRData {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal: string;
}

export interface Phase2QRData extends Phase1QRData {
  invoiceHash: string;            // Tag 6 — SHA-256 hash of invoice
  ecdsaSignature: string;         // Tag 7 — ECDSA signature (IEEE P1363)
  ecdsaPublicKey: string;         // Tag 8 — ECDSA public key
  certificateSignature: string;   // Tag 9 — ZATCA CA signature on public key
}

// ---- Hash Chain Types ----

export interface HashChainState {
  lastHash: string;
  lastUuid: string;
  counter: number;
  updatedAt: string;
}
