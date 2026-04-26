/**
 * ZATCA Phase 2 Types
 */

// ---- Environment ----

export type ZatcaEnvironment = 'sandbox' | 'production';

// ---- Invoice Types ----

export type InvoiceTypeCode = '388' | '381' | '383';
// 388 = Simplified Tax Invoice (B2C)
// 381 = Standard Tax Invoice (B2B)
// 383 = Debit Note

export type InvoiceTypeCodeName =
  | '0200000'  // Simplified (B2C)
  | '0100000'  // Standard (B2B)
  | '0300000'; // Debit Note

export type TaxCategoryId = 'S' | 'Z' | 'E' | 'O' | 'AE';
// S = Standard rated
// Z = Zero rated
// E = Exempt
// O = Out of scope
// AE = Reverse charge

export type ProfileId = 'reporting:1.0' | 'clearance:1.0';

export type SubmissionType = 'CLEARANCE' | 'REPORTING';

export interface PostalAddress {
  street: string;
  building: string;
  district: string;
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
  taxableAmount: number;
  taxAmount: number;
  percent: number;
  taxCategoryId: TaxCategoryId;
}

export interface InvoiceLineItem {
  id: number;
  quantity: number;
  unitCode: string; // UN/ECE Rec 20, e.g. "C62" (unit), "EA" (each)
  lineExtensionAmount: number;
  taxAmount: number;
  itemName: string;
  taxCategoryId: TaxCategoryId;
  taxPercent: number;
  priceAmount: number;
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
  previousInvoiceHash?: string; // PIH — hash chain

  // Parties
  supplier: SupplierInfo;
  customer?: CustomerInfo;

  // Totals
  lineExtensionAmount: number;
  taxExclusiveAmount: number;
  taxInclusiveAmount: number;
  allowanceTotalAmount?: number;
  payableAmount: number;
  taxAmount: number;

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

// ---- Certificate Types ----

export interface CSRParams {
  organizationNameAr: string;
  organizationNameEn: string;
  vatNumber: string;
  crNumber: string;
  country: string;
  commonName: string;
  invoiceType: string;
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
  invoiceHash: string;        // Tag 6
  cryptographicStamp: string; // Tag 7 — ECDSA signature
  publicKey: string;          // Tag 8 — Public key
}

// ---- Hash Chain Types ----

export interface HashChainState {
  lastHash: string;
  lastUuid: string;
  counter: number;
  updatedAt: string;
}
