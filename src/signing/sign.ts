/**
 * XML Digital Signature for ZATCA invoices
 *
 * Builds the XML-DSig/XAdES structure expected by ZATCA's Java SDK and signs
 * the canonical SignedInfo block with ECDSA-SHA256 DER encoding.
 *
 * ZATCA requirements:
 * - Signature algorithm: ECDSA-SHA256
 * - Canonicalization: Canonical XML 1.1
 * - Digest: SHA-256
 * - Signature placement: ext:UBLExtensions > ext:UBLExtension > ext:ExtensionContent
 */

import crypto from 'crypto';

import { DOMParser } from '@xmldom/xmldom';
import { Effect } from 'effect';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { toZatcaEffectError, type ZatcaEffectError } from '../effect/errors.js';

import { XmlCanonicalizer } from 'xmldsigjs';
import {
  assembleSignedXml,
  buildPhase2QrTlvBytes,
  buildSdkSignedPropertiesDigestXml,
  buildSignatureXmlWithSignedProperties,
  buildSignedInfo,
  canonicalizeXml,
  formatSigningTime,
  pemBody,
  type CertificateInfoFragment,
  type QrTlvInput,
} from './shared.js';

type CanonicalizerNode = Parameters<XmlCanonicalizer['Canonicalize']>[0];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignParams {
  /** Raw UBL 2.1 Invoice or CreditNote XML string (with empty ext:UBLExtensions placeholder) */
  xml: string;
  /** ECDSA private key in PEM format */
  privateKeyPem: string;
  /** X.509 certificate in PEM format (ZATCA CSID certificate) */
  certificatePem: string;
  /** QR code data for Phase 2 (Tags 1-5, 9). Tags 6-8 are computed automatically. */
  qrData?: QRInvoiceData;
}

/** QR data that must be provided by the caller (Tags 1-5, 9). Tags 6-8 are auto-computed. */
export interface QRInvoiceData {
  sellerName: string;
  vatNumber: string;
  timestamp: string; // ISO 8601: YYYY-MM-DDTHH:MM:SSZ
  totalWithVat: string;
  vatTotal: string;
  /** ZATCA CA certificate signature (from CSID, base64) — Tag 9 */
  certificateSignature: string;
}

export interface SignResult {
  /** Signed XML with ECDSA signature embedded in UBLExtensions */
  signedXml: string;
  /** Base64-encoded SHA-256 hash of the invoice (for hash chain PIH and QR Tag 6) */
  invoiceHash: string;
  /** Base64 DER-encoded ECDSA signature value (for XMLDSig SignatureValue and QR Tag 7) */
  signatureValue: string;
}

export type ExternalSignerAlgorithm = 'ECDSA_SHA256';

export type SignatureEncoding = 'base64_der' | 'base64_ieee_p1363';

export interface ExternalSignerInput {
  algorithm: ExternalSignerAlgorithm;
  /** UTF-8 bytes of canonical XMLDSig SignedInfo. Sign these bytes with ECDSA-SHA256. */
  canonicalSignedInfo: Uint8Array;
  /** Explicit signature encoding required by this XMLDSig implementation. */
  expectedSignatureEncoding: 'base64_der';
}

export interface ExternalSignerResult {
  /** Base64-encoded ECDSA signature. Must match signatureEncoding. */
  signatureValue: string;
  signatureEncoding: SignatureEncoding;
}

export interface ZatcaExternalSigner {
  readonly algorithm?: ExternalSignerAlgorithm;
  sign(input: ExternalSignerInput): Promise<ExternalSignerResult>;
}

export type ZatcaExternalSignerCallback = (input: ExternalSignerInput) => Promise<ExternalSignerResult>;

export interface SignWithExternalSignerParams {
  /** Raw UBL 2.1 Invoice or CreditNote XML string (with empty ext:UBLExtensions placeholder) */
  xml: string;
  /** X.509 certificate in PEM format (ZATCA CSID certificate) */
  certificatePem: string;
  /** QR code data for Phase 2 (Tags 1-5, 9). Tags 6-8 are computed automatically. */
  qrData?: QRInvoiceData;
  /** Async signer callback or signer object. It must return base64 DER-encoded ECDSA-SHA256. */
  signer: ZatcaExternalSigner | ZatcaExternalSignerCallback;
  /** Optional base64 SPKI public key for QR Tag 8. Defaults to the certificate public key. */
  qrPublicKey?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertBase64(fieldName: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
    throw new Error(`${fieldName} must be valid base64`);
  }
  return trimmed;
}

function base64ToBytes(fieldName: string, value: string): Buffer {
  return Buffer.from(assertBase64(fieldName, value), 'base64');
}

// Runtime base64 codecs for the shared QR TLV builder: validation and
// decoding stay Node-flavored (Buffer round-trip) exactly as before.
const qrTlvCodecs = {
  assertBase64,
  base64ToBytes,
};

function wrapCertificateBody(body: string): string {
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----`;
}

function normalizeCertificatePem(certificate: string): string {
  const compact = certificate.includes('BEGIN CERTIFICATE')
    ? pemBody(certificate)
    : certificate.trim().replace(/\s+/g, '');

  const directDer = Buffer.from(compact, 'base64');
  if (directDer[0] === 0x30) {
    return wrapCertificateBody(compact);
  }

  const decoded = directDer.toString('utf8').trim();
  if (decoded.includes('BEGIN CERTIFICATE')) {
    return normalizeCertificatePem(decoded);
  }

  const decodedCompact = decoded.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(decodedCompact)) {
    const nestedDer = Buffer.from(decodedCompact, 'base64');
    if (nestedDer[0] === 0x30) {
      return wrapCertificateBody(decodedCompact);
    }
  }

  return wrapCertificateBody(compact);
}

/**
 * Base64-encode the Phase 2 QR TLV payload (Tags 1-9). The TLV byte layout
 * lives in the shared module; this wrapper keeps the Node base64 encoding
 * (Buffer) and Node base64 validation semantics.
 */
function generateQrBase64(data: QrTlvInput): string {
  return Buffer.from(buildPhase2QrTlvBytes(data, qrTlvCodecs)).toString('base64');
}

function extractSpkiPublicKeyFromKey(key: crypto.KeyObject): string {
  const spkiDer = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(spkiDer).toString('base64');
}

function extractRawPublicKeyFromKey(key: crypto.KeyObject): string {
  return Buffer.from(key.export({ type: 'spki', format: 'der' })).slice(-65).toString('base64');
}

function extractPrivateKeyRawPublicKey(privateKeyPem: string): string {
  return extractRawPublicKeyFromKey(crypto.createPublicKey(privateKeyPem));
}

function extractQrPublicKey(certificatePem: string, privateKeyPem: string): string {
  const privateKey = crypto.createPublicKey(privateKeyPem);
  const privateKeyPublicKey = extractSpkiPublicKeyFromKey(privateKey);

  try {
    const certificateKey = new crypto.X509Certificate(certificatePem).publicKey;
    const certificatePublicKey = extractSpkiPublicKeyFromKey(certificateKey);

    if (certificatePublicKey !== privateKeyPublicKey) {
      throw new Error('Private key does not match the supplied CSID certificate');
    }

    return certificatePublicKey;
  } catch (error) {
    const message = (error as Error).message;
    if (!/decode|asn1|encoding/i.test(message)) {
      throw error;
    }
  }

  return privateKeyPublicKey;
}

function extractCertificatePublicKey(certificatePem: string): string {
  return extractSpkiPublicKeyFromKey(new crypto.X509Certificate(certificatePem).publicKey);
}

function getUblRoot(xml: string): { name: 'Invoice' | 'CreditNote'; namespace: string } {
  if (/<Invoice(?:\s|>)/.test(xml)) {
    return {
      name: 'Invoice',
      namespace: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    };
  }
  if (/<CreditNote(?:\s|>)/.test(xml)) {
    return {
      name: 'CreditNote',
      namespace: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
    };
  }
  throw new Error('Unsupported UBL document: expected Invoice or CreditNote root element');
}

function getCertificateInfo(certificatePem: string): CertificateInfoFragment {
  const cert = new crypto.X509Certificate(certificatePem);
  const certificateBase64 = pemBody(certificatePem);
  const digestHex = crypto.createHash('sha256').update(certificateBase64, 'utf8').digest('hex');
  return {
    digestValue: Buffer.from(digestHex, 'utf8').toString('base64'),
    issuerName: cert.issuer.split('\n').reverse().join(', '),
    serialNumber: BigInt(`0x${cert.serialNumber}`).toString(10),
  };
}

function hashForDigestValue(canonicalXml: string): string {
  const digestHex = crypto.createHash('sha256').update(canonicalXml, 'utf8').digest('hex');
  return Buffer.from(digestHex, 'utf8').toString('base64');
}

function digestSdkSignedProperties(certificate: CertificateInfoFragment, signingTime: string): string {
  return hashForDigestValue(buildSdkSignedPropertiesDigestXml(certificate, signingTime));
}

function signSignedInfo(canonicalSignedInfo: string, privateKeyPem: string): string {
  const signer = crypto.createSign('SHA256');
  signer.update(canonicalSignedInfo, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

function assertExternalSignerResult(result: ExternalSignerResult): string {
  if (result.signatureEncoding === 'base64_ieee_p1363') {
    throw new Error('External signer returned base64_ieee_p1363, but this XMLDSig path currently requires base64_der. TODO: convert Web Crypto raw P1363 signatures to DER before using this signer.');
  }
  if (result.signatureEncoding !== 'base64_der') {
    throw new Error(`Unsupported external signature encoding: ${result.signatureEncoding}`);
  }
  return assertBase64('signatureValue', result.signatureValue);
}

function resolveExternalSigner(signer: ZatcaExternalSigner | ZatcaExternalSignerCallback): ZatcaExternalSignerCallback {
  if (typeof signer === 'function') {
    return signer;
  }
  if (signer.algorithm && signer.algorithm !== 'ECDSA_SHA256') {
    throw new Error(`Unsupported external signer algorithm: ${signer.algorithm}`);
  }
  return signer.sign.bind(signer);
}

interface SigningContext {
  xml: string;
  ublRoot: { name: 'Invoice' | 'CreditNote'; namespace: string };
  normalizedCertificatePem: string;
  certificateBase64: string;
  certificateInfo: {
    digestValue: string;
    issuerName: string;
    serialNumber: string;
  };
  publicKey: string;
  qrData?: QRInvoiceData;
}

function buildSigningContext(params: {
  xml: string;
  certificatePem: string;
  qrData?: QRInvoiceData;
  publicKey: string;
}): SigningContext {
  const { xml, certificatePem, qrData, publicKey } = params;
  const ublRoot = getUblRoot(xml);
  if (!/<ext:UBLExtensions\b[\s\S]*?<\/ext:UBLExtensions>/.test(xml)) {
    throw new Error('Invoice XML must contain ext:UBLExtensions placeholder');
  }
  const normalizedCertificatePem = normalizeCertificatePem(certificatePem);
  return {
    xml,
    ublRoot,
    normalizedCertificatePem,
    certificateBase64: pemBody(normalizedCertificatePem),
    certificateInfo: getCertificateInfo(normalizedCertificatePem),
    publicKey,
    qrData,
  };
}

function buildSignedXmlWithSignature(
  context: SigningContext,
  invoiceHash: string,
  signatureValue: string,
  signingTime: string,
): SignResult {
  const signedPropertiesDigest = digestSdkSignedProperties(context.certificateInfo, signingTime);
  const signedInfoXml = buildSignedInfo(invoiceHash, signedPropertiesDigest);
  const signatureXml = buildSignatureXmlWithSignedProperties(
    signedInfoXml,
    signatureValue,
    context.certificateBase64,
    context.certificateInfo,
    signingTime,
  );

  const signedXml = assembleSignedXml({
    xml: context.xml,
    ublRootName: context.ublRoot.name,
    signatureXml,
    qrBase64: context.qrData
      ? generateQrBase64({
          sellerName: context.qrData.sellerName,
          vatNumber: context.qrData.vatNumber,
          timestamp: context.qrData.timestamp,
          totalWithVat: context.qrData.totalWithVat,
          vatTotal: context.qrData.vatTotal,
          invoiceHash,
          signatureValue,
          publicKey: context.publicKey,
          certificateSignature: context.qrData.certificateSignature,
        })
      : undefined,
  });

  return { signedXml, invoiceHash, signatureValue };
}

function createSignedInfoForHash(context: SigningContext, invoiceHash: string): {
  signedInfoXml: string;
  canonicalSignedInfo: string;
  signingTime: string;
} {
  const signingTime = formatSigningTime();
  const signedPropertiesDigest = digestSdkSignedProperties(context.certificateInfo, signingTime);
  const signedInfoXml = buildSignedInfo(invoiceHash, signedPropertiesDigest);
  return {
    signedInfoXml,
    canonicalSignedInfo: canonicalizeXml(signedInfoXml),
    signingTime,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign a ZATCA invoice XML with ECDSA-SHA256.
 *
 * Pipeline:
 * 1. Compute invoice hash (without UBLExtensions) for QR and hash chain
 * 2. Build the XML-DSig structure (references, transforms, SignedInfo)
 * 3. Sign canonical SignedInfo with ECDSA-SHA256 using DER encoding
 * 4. Build UBL DocumentSignatures wrapper
 * 5. Replace empty UBLExtensions with signed version
 */
export function signInvoice(params: SignParams): SignResult {
  try {
    const { xml, privateKeyPem, certificatePem, qrData } = params;
    const normalizedCertificatePem = normalizeCertificatePem(certificatePem);
    const context = buildSigningContext({
      xml,
      certificatePem: normalizedCertificatePem,
      qrData,
      publicKey: extractQrPublicKey(normalizedCertificatePem, privateKeyPem),
    });
    const buildSignedXml = (invoiceHash: string): SignResult => {
      const { canonicalSignedInfo, signingTime } = createSignedInfoForHash(context, invoiceHash);
      const signatureValue = signSignedInfo(canonicalSignedInfo, privateKeyPem);
      return buildSignedXmlWithSignature(context, invoiceHash, signatureValue, signingTime);
    };

    let invoiceHash = canonicalizeForHash(xml).hashBase64;
    let signed = buildSignedXml(invoiceHash);
    const finalHash = canonicalizeForHash(signed.signedXml).hashBase64;
    if (finalHash !== invoiceHash) {
      signed = buildSignedXml(finalHash);
    }

    return signed;
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to sign invoice: ${(error as Error).message}`,
      ZatcaErrorCode.SIGN_ERROR,
      error,
    );
  }
}

/**
 * Sign a ZATCA invoice XML through an async external signer.
 *
 * The external signer receives canonical XMLDSig SignedInfo bytes and must
 * return a base64 DER-encoded ECDSA-SHA256 signature. Web Crypto returns raw
 * IEEE-P1363 ECDSA bytes; that encoding is rejected until explicit DER
 * conversion is wired.
 */
export async function signInvoiceWithExternalSigner(params: SignWithExternalSignerParams): Promise<SignResult> {
  try {
    const { xml, certificatePem, qrData } = params;
    const normalizedCertificatePem = normalizeCertificatePem(certificatePem);
    const context = buildSigningContext({
      xml,
      certificatePem: normalizedCertificatePem,
      qrData,
      publicKey: params.qrPublicKey ?? extractCertificatePublicKey(normalizedCertificatePem),
    });
    const sign = resolveExternalSigner(params.signer);
    const buildSignedXml = async (invoiceHash: string): Promise<SignResult> => {
      const { canonicalSignedInfo, signingTime } = createSignedInfoForHash(context, invoiceHash);
      const result = await sign({
        algorithm: 'ECDSA_SHA256',
        canonicalSignedInfo: Buffer.from(canonicalSignedInfo, 'utf8'),
        expectedSignatureEncoding: 'base64_der',
      });
      const signatureValue = assertExternalSignerResult(result);
      return buildSignedXmlWithSignature(context, invoiceHash, signatureValue, signingTime);
    };

    let invoiceHash = canonicalizeForHash(xml).hashBase64;
    let signed = await buildSignedXml(invoiceHash);
    const finalHash = canonicalizeForHash(signed.signedXml).hashBase64;
    if (finalHash !== invoiceHash) {
      signed = await buildSignedXml(finalHash);
    }

    return signed;
  } catch (error) {
    if (error instanceof ZatcaError) throw error;
    throw new ZatcaError(
      `Failed to sign invoice with external signer: ${(error as Error).message}`,
      ZatcaErrorCode.SIGN_ERROR,
      error,
    );
  }
}

/**
 * Compute SHA-256 hash of invoice XML (without UBLExtensions content and QR)
 * as a 64-character lowercase HEX digest string.
 *
 * NOTE: this hex digest is NOT the format ZATCA consumers need. The hash used
 * for the API body `invoiceHash` field, QR code Tag 6, and the Previous
 * Invoice Hash (PIH) is the BASE64 encoding of the same digest — use
 * `canonicalizeForHash(xml).hashBase64` for those (this is what
 * {@link signInvoice} embeds in `SignResult.invoiceHash`).
 *
 * Both UBLExtensions and QR AdditionalDocumentReference are stripped before
 * hashing — the hash covers only the core invoice data.
 */
export function computeInvoiceHash(xml: string): string {
  return canonicalizeForHash(xml).hash;
}

/**
 * Compute SHA-256 hash of invoice XML as base64-encoded raw bytes.
 * This is the format ZATCA expects for API body `invoiceHash` and PIH.
 */
function computeInvoiceHashBase64(xml: string): string {
  return canonicalizeForHash(xml).hashBase64;
}

/**
 * Canonicalize an invoice XML for hash computation.
 *
 * Steps (matching ZATCA SDK R3.4.8):
 * 1. Remove UBLExtensions elements
 * 2. Remove cac:Signature elements
 * 3. Remove QR AdditionalDocumentReference (optional)
 * 4. Apply canonical XML after the ZATCA exclusion transforms
 * 5. SHA-256 hash + Base64 encode
 */
export function canonicalizeForHash(xml: string, stripQR = true): { canonical: string; hash: string; hashBase64: string } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  // Remove UBLExtensions
  const ublExts = doc.getElementsByTagNameNS(
    'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
    'UBLExtensions',
  );
  for (let i = ublExts.length - 1; i >= 0; i--) {
    ublExts[i].parentNode?.removeChild(ublExts[i]);
  }

  // Remove cac:Signature elements
  const sigs = doc.getElementsByTagNameNS(
    'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    'Signature',
  );
  for (let i = sigs.length - 1; i >= 0; i--) {
    sigs[i].parentNode?.removeChild(sigs[i]);
  }

  // Remove QR AdditionalDocumentReference
  if (stripQR) {
    const docRefs = doc.getElementsByTagNameNS(
      'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
      'AdditionalDocumentReference',
    );
    for (let i = docRefs.length - 1; i >= 0; i--) {
      const idEl = docRefs[i].getElementsByTagNameNS(
        'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
        'ID',
      )[0];
      if (idEl && idEl.textContent === 'QR') {
        docRefs[i].parentNode?.removeChild(docRefs[i]);
      }
    }
  }

  // ZATCA SDK uses Canonical XML 1.1 here; this canonicalizer is the closest
  // compatible implementation available in the runtime dependencies.
  const canonicalizer = new XmlCanonicalizer(false, false);
  const canonical = canonicalizer.Canonicalize(doc as unknown as CanonicalizerNode) as string;

  const hashBytes = crypto.createHash('sha256').update(canonical, 'utf8').digest();
  return {
    canonical,
    hash: hashBytes.toString('hex'),
    hashBase64: hashBytes.toString('base64'),
  };
}

/**
 * Verify an invoice signature (for testing / debugging).
 *
 * Extracts the ECDSA signature and verifies it against the canonicalized
 * invoice content (without the Signature element).
 *
 * @returns `true` if the signature is valid, `false` otherwise
 */
export function verifySignature(
  signedXml: string,
  publicKeyPem: string,
): boolean {
  try {
    // Extract SignedInfo + SignatureValue. The signature in this package's
    // pipeline is computed over the CANONICALIZED ds:SignedInfo (matching
    // createSignedInfoForHash in the signing path) — verifying anything
    // else would reject every document signed by signInvoice().
    const sigMatch = signedXml.match(
      /<ds:SignatureValue[^>]*>([^<]+)<\/ds:SignatureValue>/,
    );
    const signedInfoMatch = signedXml.match(
      /<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/,
    );
    if (!sigMatch || !signedInfoMatch) return false;

    const canonical = canonicalizeXml(signedInfoMatch[0]);

    // Verify ECDSA-SHA256 signature (DER encoding)
    const verifier = crypto.createVerify('sha256');
    verifier.update(canonical, 'utf8');
    verifier.end();

    return verifier.verify(
      { key: publicKeyPem },
      sigMatch[1],
      'base64',
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Effect twin
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Effect twin
// ---------------------------------------------------------------------------

/**
 * Effect twin of {@link signInvoiceWithExternalSigner}: identical pipeline,
 * failures surfaced as tagged ZATCA errors (sign/validation problems as
 * ZatcaValidationError/ZatcaApiError with the legacy code preserved).
 */
export const signInvoiceWithExternalSignerEffect = Effect.fn('signInvoiceWithExternalSignerEffect')(
  function* (params: SignWithExternalSignerParams): Effect.fn.Return<SignResult, ZatcaEffectError> {
    return yield* Effect.tryPromise({
      try: () => signInvoiceWithExternalSigner(params),
      catch: toZatcaEffectError,
    });
  },
);
