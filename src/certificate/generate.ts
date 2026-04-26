/**
 * Certificate & CSR Generation for ZATCA Phase 2
 *
 * Generates RSA key pairs and PKCS#10 CSRs with ZATCA-specific OID extensions
 * using node-forge for proper ASN.1/DER encoding.
 *
 * Key design decisions:
 * - RSA 2048 for CSR generation (node-forge doesn't support ECDSA key gen)
 * - ECDSA P-256 for actual signing (via Node.js crypto) — separate function
 * - ZATCA-specific extensions added as CSR attributes
 */

import crypto from 'node:crypto';
import forge from 'node-forge';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { validateCSRParams } from '../utils/validation.js';
import type { CSRParams, CSRResult } from '../types.js';

/**
 * Generate an RSA key pair and PKCS#10 CSR for ZATCA onboarding.
 *
 * The CSR subject contains:
 * - CN = EGS serial number (format: EGS-{TIN}-{serial})
 * - OU = Invoice type (1 = standard, 2 = simplified, 3 = both)
 * - O  = Organization name (English)
 * - C  = Country code (SA)
 *
 * Extensions include Subject Alternative Name (SAN) with the EGS serial number.
 */
export function generateCSR(params: CSRParams): CSRResult {
  try {
    validateCSRParams(params);

    // 1. Generate RSA 2048 key pair
    const keys = forge.pki.rsa.generateKeyPair(2048);

    // 2. Create CSR
    const csr = forge.pki.createCertificationRequest();

    // 3. Set public key and subject DN
    csr.publicKey = keys.publicKey;

    csr.subject.addField({
      name: 'commonName',
      value: params.egsSerialNumber,
    });
    csr.subject.addField({
      name: 'organizationName',
      value: params.organizationNameEn,
    });
    csr.subject.addField({
      name: 'organizationalUnitName',
      value: params.invoiceType || '1',
    });
    csr.subject.addField({
      name: 'countryName',
      value: params.country || 'SA',
    });

    // 4. Add ZATCA-specific extensions as attributes
    // Subject Alternative Name (SAN) with EGS serial number
    csr.addAttribute({
      name: 'extensionRequest',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            {
              type: 1, // RFC822Name
              value: params.egsSerialNumber,
            },
          ],
        },
      ],
    });

    // 5. Sign CSR with private key using SHA-256
    csr.sign(keys.privateKey, forge.md.sha256.create());

    // 6. Verify CSR self-consistency
    if (!csr.verify()) {
      throw new ZatcaError(
        'CSR verification failed after signing',
        ZatcaErrorCode.CERT_GEN_ERROR,
      );
    }

    // 7. Convert to PEM
    const csrPem = forge.pki.certificationRequestToPem(csr);
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const publicKeyPem = forge.pki.publicKeyToPem(keys.publicKey);

    return {
      csr: csrPem,
      privateKey: privateKeyPem,
      publicKey: publicKeyPem,
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
 * Generate an ECDSA P-256 key pair using Node.js crypto.
 *
 * Use this for actual invoice signing — ZATCA requires ECDSA for
 * digital signatures, but node-forge can only generate RSA keys.
 * The CSR itself uses RSA (see generateCSR), while signing uses
 * these ECDSA keys.
 */
export function generateECDSAKeyPair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', // P-256
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return { privateKey, publicKey };
}

/**
 * Extract public key from a PEM-encoded certificate or public key.
 *
 * Accepts both full X.509 certificates and bare public key PEMs.
 */
export function extractPublicKey(certificatePem: string): string {
  try {
    // Try parsing as a full X.509 certificate first
    const cert = forge.pki.certificateFromPem(certificatePem);
    return forge.pki.publicKeyToPem(cert.publicKey);
  } catch {
    // Fall back to parsing as a bare public key
    try {
      const key = forge.pki.publicKeyFromPem(certificatePem);
      return forge.pki.publicKeyToPem(key);
    } catch (error) {
      throw new ZatcaError(
        `Failed to extract public key: ${(error as Error).message}`,
        ZatcaErrorCode.CERT_GEN_ERROR,
        error,
      );
    }
  }
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
  const key = Buffer.from(masterKey, 'hex');
  const iv = crypto.randomBytes(12); // GCM standard: 12-byte IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(privateKeyPem, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
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
  const [ivHex, authTagHex, data] = encryptedData.split(':');

  if (!ivHex || !authTagHex || !data) {
    throw new ZatcaError(
      'Invalid encrypted data format — expected iv:authTag:data',
      ZatcaErrorCode.CERT_LOAD_ERROR,
    );
  }

  const key = Buffer.from(masterKey, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
