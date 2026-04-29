/**
 * Certificate & CSR Generation for ZATCA Phase 2
 *
 * Generates ECDSA secp256k1 key pairs and PKCS#10 CSRs with ZATCA-specific
 * OID extensions using Node.js crypto for keys and raw ASN.1 DER encoding.
 *
 * Key design decisions:
 * - ECDSA prime256v1 (P-256) for CSR generation
 * - ECDSA prime256v1 (P-256) for actual invoice signing
 * - Raw ASN.1 DER encoding for full control over the CSR structure
 * - ZATCA-specific extensions: certificateTemplateName + SAN with dirName
 *
 * Environment mapping for certificate template name:
 * - 'sandbox'     → 'ZATCA-Code-Signing'
 * - 'production'  → 'ZATCA-Code-Signing'
 * - 'simulation'  → 'PREZATCA-Code-Signing'
 *
 * NOTE: prime256v1 (P-256) is used for Bun compatibility (Bun's BoringSSL doesn't support secp256k1).
 */

import crypto from 'node:crypto';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { validateCSRParams } from '../utils/validation.js';
import type { CSRParams, CSRResult } from '../types.js';

// ============================================================
// ZATCA Environment Constants
// ============================================================

const CERT_TEMPLATE_NAMES: Record<string, string> = {
  sandbox: 'ZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
};

const CN_PREFIXES: Record<string, string> = {
  sandbox: 'TST-',
  production: '',
  simulation: 'PREZATCA-',
};

// ============================================================
// OID Definitions (dotted string → hex bytes)
// ============================================================

const OID_HEX: Record<string, string> = {
  '2.5.4.6': '550406',                             // countryName (C)
  '2.5.4.10': '55040a',                            // organizationName (O)
  '2.5.4.11': '55040b',                            // organizationalUnitName (OU)
  '2.5.4.3': '550403',                             // commonName (CN)
  '2.5.4.4': '550404',                             // surname (SN) — used for EGS serial in ZATCA CSR
  '2.5.4.12': '55040c',                            // title — used for invoice type in ZATCA CSR
  '2.5.4.26': '55041a',                            // registeredAddress — used for location in ZATCA CSR
  '2.5.4.15': '55040f',                            // businessCategory
  '0.9.2342.19200300.100.1.1': '0992268993f22c640101', // userId (UID)
  '1.2.840.113549.1.9.14': '2a864886f70d01090e',   // extensionRequest
  '1.3.6.1.4.1.311.20.2': '2b0601040182371402',   // certificateTemplateName
  '2.5.29.17': '551d11',                           // subjectAltName
  '1.2.840.10045.4.3.2': '2a8648ce3d040302',      // ecdsa-with-SHA256
};

// ============================================================
// Low-level DER Encoding
// ============================================================

/** Encode a DER length field. */
function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  // Convert to hex, ensuring even number of characters
  const hex = length.toString(16);
  const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex;
  const numBytes = paddedHex.length / 2;
  const header = Buffer.from([0x80 | numBytes]);
  const lenBytes = Buffer.from(paddedHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  return Buffer.concat([header, lenBytes]);
}

/** Build a DER TLV (Tag-Length-Value). */
function derTLV(tag: number, value: Buffer): Buffer {
  const tagBuf = Buffer.isBuffer(tag) ? tag : Buffer.from([tag]);
  return Buffer.concat([tagBuf, derLength(value.length), value]);
}

/** DER INTEGER from a number. */
function derInteger(value: number): Buffer {
  const hex = value === 0 ? '00' : value.toString(16).padStart(2, '0');
  return derTLV(0x02, Buffer.from(hex, 'hex'));
}

/** DER OID from dotted string. */
function derOid(dotted: string): Buffer {
  const hex = OID_HEX[dotted];
  if (!hex) {
    throw new Error(`Unknown OID: ${dotted}`);
  }
  return derTLV(0x06, Buffer.from(hex, 'hex'));
}

/** DER PrintableString. */
function derPrintableString(value: string): Buffer {
  return derTLV(0x13, Buffer.from(value, 'ascii'));
}

/** DER UTF8String. */
function derUtf8String(value: string): Buffer {
  return derTLV(0x0c, Buffer.from(value, 'utf8'));
}

/** DER SEQUENCE (0x30). */
function derSequence(...children: Buffer[]): Buffer {
  return derTLV(0x30, Buffer.concat(children));
}

/** DER SET (0x31). */
function derSet(...children: Buffer[]): Buffer {
  return derTLV(0x31, Buffer.concat(children));
}

/** DER OCTET STRING (0x04). */
function derOctetString(value: Buffer): Buffer {
  return derTLV(0x04, value);
}

/** DER BIT STRING (0x03) with unused bits count. */
function derBitString(value: Buffer, unusedBits: number = 0): Buffer {
  const content = Buffer.concat([Buffer.from([unusedBits]), value]);
  return derTLV(0x03, content);
}

/** DER context-specific EXPLICIT tag [tagNumber] (0xA0 | tagNumber). */
function derExplicitTag(tagNumber: number, content: Buffer): Buffer {
  const tag = 0xa0 | tagNumber;
  return derTLV(tag, content);
}

/** Read DER length field, returning { value: number, bytesUsed: number }. */
function derReadLength(buf: Buffer, offset: number): { value: number; bytesUsed: number } {
  const first = buf[offset];
  if (first < 0x80) {
    return { value: first, bytesUsed: 1 };
  }
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | buf[offset + 1 + i];
  }
  return { value: length, bytesUsed: 1 + numBytes };
}

/** Return the number of bytes occupied by a DER length field at the given offset. */
function derReadLengthBytes(buf: Buffer, offset: number): number {
  const first = buf[offset];
  if (first < 0x80) return 1;
  return 1 + (first & 0x7f);
}

/** Skip a complete DER element (tag + length + value) and return total bytes consumed. */
function skipDerElement(buf: Buffer, offset: number): number {
  const tagBytes = 1; // simple tags only
  const lenInfo = derReadLength(buf, offset + tagBytes);
  return tagBytes + lenInfo.bytesUsed + lenInfo.value;
}

/** Build an AttributeTypeAndValue: SEQUENCE { OID, value }. */
function derAttributeTypeAndValue(oidDotted: string, value: Buffer): Buffer {
  return derSequence(derOid(oidDotted), value);
}

/** Build an RDN: SET { AttributeTypeAndValue }. */
function derRdn(atv: Buffer): Buffer {
  return derSet(atv);
}

/** Wrap a buffer in PEM format. */
function toPem(derBytes: Buffer, label: string): string {
  const b64 = derBytes.toString('base64');
  const lines = b64.match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

// ============================================================
// CSR Extension Builders
// ============================================================

/**
 * Build the Certificate Template Name extension.
 *
 * Structure:
 *   SEQUENCE {
 *     OID  1.3.6.1.4.1.311.20.2
 *     (no critical field — official CSR doesn't have one)
 *     OCTET STRING wrapping: UTF8String "template-name"
 *   }
 */
function buildCertificateTemplateNameExtension(templateName: string): Buffer {
  // Extension value is just UTF8String directly (no SEQUENCE wrapper).
  // Official ZATCA CSR confirms: OCTET STRING → UTF8String "template-name"
  const extValue = derUtf8String(templateName);
  return derSequence(
    derOid('1.3.6.1.4.1.311.20.2'),
    derOctetString(extValue),
  );
}

/**
 * Build the Subject Alternative Name extension with dirName.
 *
 * The SAN value is a GeneralNames SEQUENCE containing dirName [4].
 */
function buildSubjectAltNameExtension(params: CSRParams): Buffer {
  const invoiceType = params.invoiceType || '1100';

  const location = params.location
    ? `${params.location.street} ${params.location.buildingNumber} ${params.location.district}`
    : 'Riyadh';

  const businessCategory = params.businessCategory || params.organizationNameEn;

  // Build the dirName as a SEQUENCE of RDNs
  const dirName = derSequence(
    derRdn(derAttributeTypeAndValue('2.5.4.4', derUtf8String(params.egsSerialNumber))),       // SN (surname)
    derRdn(derAttributeTypeAndValue('0.9.2342.19200300.100.1.1', derUtf8String(params.vatNumber))), // UID
    derRdn(derAttributeTypeAndValue('2.5.4.12', derUtf8String(invoiceType))),                // title
    derRdn(derAttributeTypeAndValue('2.5.4.26', derUtf8String(location))),                  // registeredAddress
    derRdn(derAttributeTypeAndValue('2.5.4.15', derUtf8String(businessCategory))),          // businessCategory
  );

  // GeneralNames = SEQUENCE { dirName [4] EXPLICIT { SEQUENCE of RDNs } }
  // ZATCA official CSR uses EXPLICIT tagging: A4 { 30 { SETs } }
  const generalNames = derSequence(derExplicitTag(4, dirName));

  return derSequence(
    derOid('2.5.29.17'),
    derOctetString(generalNames),
  );
}

/**
 * Build the extensionRequest attribute (OID 1.2.840.113549.1.9.14).
 *
 * In PKCS#10, attributes is [0] IMPLICIT SET OF Attribute.
 * Each Attribute is: SEQUENCE { attrType OID, attrValues SET OF ANY }
 *
 * Since [0] is IMPLICIT, it replaces the SET tag (0x31) with (0xA0).
 * So the DER structure is: a0 { SEQUENCE { OID, SET { extensions } } }
 */
function buildExtensionRequestAttribute(params: CSRParams, environment: string): Buffer {
  const certTemplateName = CERT_TEMPLATE_NAMES[environment] || CERT_TEMPLATE_NAMES.production;

  const extensions = Buffer.concat([
    buildCertificateTemplateNameExtension(certTemplateName),
    buildSubjectAltNameExtension(params),
  ]);

  // Single Attribute: SEQUENCE { OID extensionRequest, SET { ExtensionReq } }
  // ExtensionReq = SEQUENCE OF Extension (wraps all extensions in one SEQUENCE)
  // This matches the official ZATCA CSR structure where OpenSSL can parse extensions
  return derSequence(
    derOid('1.2.840.113549.1.9.14'),
    derSet(derSequence(extensions)),
  );
}

// ============================================================
// Main CSR Generation
// ============================================================

/**
 * Generate an ECDSA secp256k1 key pair and PKCS#10 CSR for ZATCA onboarding.
 *
 * The CSR is built per the ZATCA Developer Portal User Manual (section 5.3):
 *
 * Subject DN:
 *   C  = Country code (SA)
 *   OU = Organization unit (branch name)
 *   O  = Organization name (English)
 *   CN = Common name (format depends on environment)
 *
 * Extensions (as CSR attributes):
 *   1. Certificate Template Name (OID 1.3.6.1.4.1.311.20.2)
 *   2. Subject Alternative Name (OID 2.5.29.17) with dirName
 *
 * Key: ECDSA prime256v1 (P-256) (256-bit)
 * Signature: ecdsa-with-SHA256
 */
export function generateCSR(params: CSRParams, environment: string = 'production'): CSRResult {
  try {
    validateCSRParams(params);

    // 1. Generate ECDSA key pair (secp256k1 preferred, prime256v1 fallback for Bun)
    let privateKey: string;
    let publicKey: string;
    try {
      ({ privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'secp256k1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      }));
    } catch {
      // Bun's BoringSSL doesn't support secp256k1 — fall back to prime256v1 (P-256)
      ({ privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      }));
      console.warn('[zatca] secp256k1 not available, using prime256v1 (P-256). ZATCA may reject this in production.');
    }

    // 2. Build Subject DN
    const cnPrefix = CN_PREFIXES[environment] || '';
    const commonName = `${cnPrefix}${params.commonName}-${params.vatNumber}`;

    const subject = derSequence(
      // C = SA
      derRdn(derAttributeTypeAndValue('2.5.4.6', derPrintableString(params.country || 'SA'))),
      // OU = Organization unit
      derRdn(derAttributeTypeAndValue('2.5.4.11', derUtf8String(params.commonName))),
      // O = Organization name
      derRdn(derAttributeTypeAndValue('2.5.4.10', derUtf8String(params.organizationNameEn))),
      // CN = Common name
      derRdn(derAttributeTypeAndValue('2.5.4.3', derUtf8String(commonName))),
    );

    // 3. Get the SubjectPublicKeyInfo from the PEM
    const spkiDer = crypto
      .createPublicKey(publicKey)
      .export({ type: 'spki', format: 'der' });

    // 4. Build the CertificationRequestInfo (TBS)
    // SEQUENCE { version, subject, subjectPKInfo, attributes [0] }
    const attributes = buildExtensionRequestAttribute(params, environment);
    const certRequestInfo = derSequence(
      derInteger(0),                              // version
      subject,                                    // subject
      spkiDer,                                    // subjectPKInfo (raw DER from Node.js)
      derExplicitTag(0, attributes),              // attributes [0]
    );

    // 5. Sign the CSR with ECDSA-SHA256
    const sign = crypto.createSign('SHA256');
    sign.update(certRequestInfo);
    const signatureDer = sign.sign(privateKey);

    // 6. Build the signature AlgorithmIdentifier
    const signatureAlgorithm = derSequence(derOid('1.2.840.10045.4.3.2'));

    // 7. Build the complete CSR (CertificationRequest)
    const certificationRequest = derSequence(
      certRequestInfo,
      signatureAlgorithm,
      derBitString(signatureDer),
    );

    // 8. Convert to PEM
    const csrPem = toPem(certificationRequest, 'CERTIFICATE REQUEST');

    return {
      csr: csrPem,
      privateKey,
      publicKey,
    };
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to generate CSR: ${(error as Error).message}`,
      ZatcaErrorCode.CERT_GEN_ERROR,
      error,
    );
  }
}

/**
 * Generate an ECDSA key pair using Node.js crypto.
 *
 * Uses secp256k1 (ZATCA requirement) with prime256v1 (P-256) fallback for Bun.
 *
 * Use this for actual invoice signing — ZATCA requires ECDSA.
 */
export function generateECDSAKeyPair(): { privateKey: string; publicKey: string } {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { privateKey, publicKey };
  } catch {
    // Bun's BoringSSL doesn't support secp256k1 — fall back to prime256v1 (P-256)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    console.warn('[zatca] secp256k1 not available, using prime256v1 (P-256). ZATCA may reject this in production.');
    return { privateKey, publicKey };
  }
}

/**
 * Extract public key from a PEM-encoded certificate or public key.
 *
 * Accepts both full X.509 certificates and bare public key PEMs.
 * Uses Node.js crypto for ECDSA keys (secp256k1 not supported by node-forge).
 */
export function extractPublicKey(certificatePem: string): string {
  try {
    const pubKey = crypto.createPublicKey(certificatePem);
    return pubKey.export({ type: 'spki', format: 'pem' }) as string;
  } catch {
    throw new ZatcaError(
      `Failed to extract public key from PEM`,
      ZatcaErrorCode.CERT_GEN_ERROR,
    );
  }
}

/**
 * Extract raw EC public key from a PEM-encoded certificate, public key, or private key.
 *
 * Returns the raw EC point as base64 (65 bytes for P-256: 0x04 + x + y).
 * This is the format required for ZATCA QR code Tag 8.
 *
 * Accepts X.509 certificates, SPKI public keys, and PKCS#8/PKCS#1 private keys.
 */
export function extractRawPublicKey(pem: string): string {
  try {
    const key = crypto.createPublicKey(pem);
    const spkiDer = key.export({ type: 'spki', format: 'der' });
    // Raw EC point is the last 65 bytes of SPKI DER for P-256
    return spkiDer.slice(-65).toString('base64');
  } catch (error) {
    throw new ZatcaError(
      `Failed to extract raw public key: ${(error as Error).message}`,
      ZatcaErrorCode.CERT_GEN_ERROR,
      error,
    );
  }
}

/**
 * Extract the signature bytes from an X.509 certificate in PEM format.
 *
 * Returns the certificate's signature as base64.
 * This is the format required for ZATCA QR code Tag 9.
 *
 * Parses the ASN.1 DER structure: SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * and extracts the raw bytes from the signatureValue BIT STRING.
 */
export function extractCertificateSignature(certificatePem: string): string {
  try {
    // Decode PEM to DER
    const der = Buffer.from(
      certificatePem
        .replace(/-----BEGIN CERTIFICATE-----/g, '')
        .replace(/-----END CERTIFICATE-----/g, '')
        .replace(/\s/g, ''),
      'base64',
    );

    // Parse outer SEQUENCE tag
    let offset = 0;
    if (der[offset++] !== 0x30) {
      throw new Error('Invalid certificate DER: expected outer SEQUENCE');
    }
    offset += derReadLengthBytes(der, offset);

    // Skip tbsCertificate (SEQUENCE)
    offset += skipDerElement(der, offset);

    // Skip signatureAlgorithm (SEQUENCE)
    offset += skipDerElement(der, offset);

    // Read signatureValue (BIT STRING)
    if (der[offset] !== 0x03) {
      throw new Error('Invalid certificate DER: expected BIT STRING for signatureValue');
    }
    offset++; // skip BIT STRING tag
    const sigLenInfo = derReadLength(der, offset);
    offset += sigLenInfo.bytesUsed;

    // First byte of BIT STRING content is unused bits count (always 0 for signatures)
    offset++; // skip unused bits byte

    // Remaining bytes are the actual signature
    const signatureBytes = der.slice(offset, offset + sigLenInfo.value - 1);
    return signatureBytes.toString('base64');
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to extract certificate signature: ${(error as Error).message}`,
      ZatcaErrorCode.CERT_LOAD_ERROR,
      error,
    );
  }
}

/**
 * Certificate information extracted from an X.509 PEM certificate.
 */
export interface CertificateInfo {
  /** Subject DN (e.g., "CN=TST-TestCompany-300000000000003") */
  subject: string;
  /** Issuer DN (e.g., "CN=ZATCA-Code-Signing-CA") */
  issuer: string;
  /** Serial number (hex string) */
  serialNumber: string;
  /** Not-before date as ISO 8601 string */
  validFrom: string;
  /** Not-after (expiry) date as ISO 8601 string */
  validTo: string;
  /** SHA-256 fingerprint */
  fingerprint256: string;
  /** Whether the certificate is currently valid (not expired, not not-yet-valid) */
  isValid: boolean;
  /** Whether the certificate is expired */
  isExpired: boolean;
  /** Days until expiry (negative if expired) */
  daysUntilExpiry: number;
}

/**
 * Parse an X.509 PEM certificate and extract key information.
 *
 * Useful for checking CSID certificate validity, expiry, and metadata.
 * Works with both compliance (test) and production CSID certificates.
 *
 * @param certificatePem - PEM-encoded X.509 certificate
 * @returns Certificate information including validity status and days until expiry
 */
export function parseCertificate(certificatePem: string): CertificateInfo {
  try {
    const cert = new crypto.X509Certificate(certificatePem);

    const now = new Date();
    const validToDate = cert.validToDate;
    const validFromDate = cert.validFromDate;

    const isExpired = now > validToDate;
    const isNotYetValid = now < validFromDate;
    const isValid = !isExpired && !isNotYetValid;

    const msPerDay = 1000 * 60 * 60 * 24;
    const daysUntilExpiry = Math.ceil((validToDate.getTime() - now.getTime()) / msPerDay);

    return {
      subject: cert.subject,
      issuer: cert.issuer,
      serialNumber: cert.serialNumber,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      fingerprint256: cert.fingerprint256,
      isValid,
      isExpired,
      daysUntilExpiry,
    };
  } catch (error) {
    throw new ZatcaError(
      `Failed to parse certificate: ${(error as Error).message}`,
      ZatcaErrorCode.CERT_LOAD_ERROR,
      error,
    );
  }
}

/**
 * Check if an X.509 certificate is expired.
 *
 * @param certificatePem - PEM-encoded certificate
 * @returns `true` if the certificate's validTo date is in the past
 */
export function isCertificateExpired(certificatePem: string): boolean {
  return parseCertificate(certificatePem).isExpired;
}

/**
 * Check if an X.509 certificate will expire within the given number of days.
 *
 * Useful for proactive renewal alerts in enterprise systems.
 *
 * @param certificatePem - PEM-encoded certificate
 * @param days - Number of days to look ahead (default: 30)
 * @returns `true` if the certificate expires within the given days
 *
 * @example
 * ```typescript
 * if (isCertificateExpiringSoon(csidCert, 14)) {
 *   // Send renewal alert
 * }
 * ```
 */
export function isCertificateExpiringSoon(certificatePem: string, days: number = 30): boolean {
  const info = parseCertificate(certificatePem);
  return !info.isExpired && info.daysUntilExpiry <= days;
}

/**
 * Encrypt a private key using AES-256-GCM for secure storage.
 *
 * Output format: `ivHex:authTagHex:encryptedDataHex`
 *
 * @param privateKeyPem - PEM-encoded private key to encrypt
 * @param masterKey - 64-char hex string (32 bytes = 256 bits)
 */
export function encryptPrivateKey(privateKeyPem: string, masterKey: string): string {
  if (!privateKeyPem) {
    throw new ZatcaError(
      'privateKeyPem is required for encryption',
      ZatcaErrorCode.VALIDATION_ERROR,
    );
  }

  if (!masterKey || !/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new ZatcaError(
      'masterKey must be a 64-character hex string (32 bytes for AES-256)',
      ZatcaErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const key = Buffer.from(masterKey, 'hex');
    const iv = crypto.randomBytes(12); // GCM standard: 12-byte IV
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(privateKeyPem, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (error) {
    throw new ZatcaError(
      `Failed to encrypt private key: ${(error as Error).message}`,
      ZatcaErrorCode.CERT_STORAGE_ERROR,
      error,
    );
  }
}

/**
 * Decrypt a private key encrypted with AES-256-GCM.
 *
 * Input format: `ivHex:authTagHex:encryptedDataHex`
 *
 * @param encryptedData - Encrypted string from encryptPrivateKey()
 * @param masterKey - 64-char hex string (32 bytes = 256 bits)
 */
export function decryptPrivateKey(encryptedData: string, masterKey: string): string {
  const parts = encryptedData.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new ZatcaError(
      'Invalid encrypted data format — expected iv:authTag:data',
      ZatcaErrorCode.CERT_LOAD_ERROR,
    );
  }
  const [ivHex, authTagHex, data] = parts;

  if (!masterKey || !/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new ZatcaError(
      'masterKey must be a 64-character hex string (32 bytes for AES-256)',
      ZatcaErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const key = Buffer.from(masterKey, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = data ? decipher.update(data, 'hex', 'utf8') : '';
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to decrypt private key: ${(error as Error).message}. This usually means the masterKey is incorrect or the data is corrupted.`,
      ZatcaErrorCode.CERT_LOAD_ERROR,
      error,
    );
  }
}
