/**
 * ZATCA Error Hierarchy
 */

export enum ZatcaErrorCode {
  // API errors
  API_ERROR = 'API_ERR',
  API_CONNECTION_ERROR = 'API_CONN_ERR',
  API_REQUEST_ERROR = 'API_REQ_ERR',
  API_TIMEOUT = 'API_TIMEOUT_ERR',

  // Certificate errors
  CERT_GEN_ERROR = 'CERT_GEN_ERR',
  CERT_STORAGE_ERROR = 'CERT_STORAGE_ERR',
  CERT_LOAD_ERROR = 'CERT_LOAD_ERR',

  // XML errors
  XML_GEN_ERROR = 'XML_GEN_ERR',
  XML_PARSE_ERROR = 'XML_PARSE_ERR',

  // Signing errors
  SIGN_ERROR = 'SIGN_ERR',
  SIGN_VERIFY_ERROR = 'SIGN_VERIFY_ERR',

  // QR errors
  QR_GEN_ERROR = 'QR_GEN_ERR',

  // Validation errors
  VALIDATION_ERROR = 'VALIDATION_ERR',

  // Hash chain errors
  HASH_CHAIN_ERROR = 'HASH_CHAIN_ERR',

  // Unknown
  UNKNOWN_ERROR = 'UNKNOWN_ERR',
}

export class ZatcaError extends Error {
  readonly code: ZatcaErrorCode;
  readonly details?: unknown;

  constructor(message: string, code: ZatcaErrorCode, details?: unknown) {
    super(message);
    this.name = 'ZatcaError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
