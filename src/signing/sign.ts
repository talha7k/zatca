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
import { ZatcaError, ZatcaErrorCode } from '../errors.js';

import { XmlCanonicalizer } from 'xmldsigjs';

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
  /** Base64-encoded ECDSA signature value (for QR Tag 7) */
  signatureValue: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ECDSA_SHA256_URI = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';
const C14N11_URI = 'http://www.w3.org/2006/12/xml-c14n11';
const SHA256_DIGEST_URI = 'http://www.w3.org/2001/04/xmlenc#sha256';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const XADES_NS = 'http://uri.etsi.org/01903/v1.3.2#';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tlvLengthHex(length: number): string {
  if (length < 128) return length.toString(16).padStart(2, '0').toUpperCase();
  if (length < 256) return `81${length.toString(16).padStart(2, '0').toUpperCase()}`;
  return `82${length.toString(16).padStart(4, '0').toUpperCase()}`;
}

function encodeTLVBytes(tag: number, valueBytes: Buffer): string {
  return tag.toString(16).padStart(2, '0').toUpperCase() + tlvLengthHex(valueBytes.length) + valueBytes.toString('hex').toUpperCase();
}

function encodeTLVText(tag: number, value: string): string {
  return encodeTLVBytes(tag, Buffer.from(value, 'utf8'));
}

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

function generatePhase2TLVForQr(data: {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal: string;
  invoiceHash: string;
  signatureValue: string;
  publicKey: string;
  certificateSignature: string;
}): string {
  const hex = [
    encodeTLVText(1, data.sellerName.trim()),
    encodeTLVText(2, data.vatNumber.trim()),
    encodeTLVText(3, data.timestamp.trim()),
    encodeTLVText(4, data.totalWithVat.trim()),
    encodeTLVText(5, (data.vatTotal ?? '0.00').trim()),
    encodeTLVText(6, assertBase64('invoiceHash', data.invoiceHash)),
    encodeTLVText(7, assertBase64('signatureValue', data.signatureValue)),
    encodeTLVBytes(8, base64ToBytes('publicKey', data.publicKey)),
    encodeTLVBytes(9, base64ToBytes('certificateSignature', data.certificateSignature)),
  ].join('');
  return Buffer.from(hex, 'hex').toString('base64');
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

function extractCertificateRawPublicKey(certificatePem: string): string {
  return extractRawPublicKeyFromKey(new crypto.X509Certificate(certificatePem).publicKey);
}

function extractQrPublicKey(certificatePem: string, privateKeyPem: string): string {
  const certificateKey = new crypto.X509Certificate(certificatePem).publicKey;
  const certificatePublicKey = extractRawPublicKeyFromKey(certificateKey);
  const privateKeyPublicKey = extractPrivateKeyRawPublicKey(privateKeyPem);

  if (certificatePublicKey !== privateKeyPublicKey) {
    throw new Error('Private key does not match the supplied CSID certificate');
  }

  return extractSpkiPublicKeyFromKey(certificateKey);
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

function getCertificateInfo(certificatePem: string): {
  digestValue: string;
  issuerName: string;
  serialNumber: string;
} {
  const cert = new crypto.X509Certificate(certificatePem);
  const der = Buffer.from(
    certificatePem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, ''),
    'base64',
  );
  const digestHex = crypto.createHash('sha256').update(der).digest('hex');
  return {
    digestValue: Buffer.from(digestHex, 'utf8').toString('base64'),
    issuerName: cert.issuer.replace(/\n/g, ', '),
    serialNumber: BigInt(`0x${cert.serialNumber}`).toString(10),
  };
}

function formatSigningTime(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

function canonicalizeXml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const canonicalizer = new XmlCanonicalizer(false, false);
  return canonicalizer.Canonicalize(doc as unknown as Node) as string;
}

function hashForDigestValue(canonicalXml: string): string {
  const digestHex = crypto.createHash('sha256').update(canonicalXml, 'utf8').digest('hex');
  return Buffer.from(digestHex, 'utf8').toString('base64');
}

function buildSignedProperties(certificate: {
  digestValue: string;
  issuerName: string;
  serialNumber: string;
}): string {
  return `<xades:SignedProperties xmlns:xades="${XADES_NS}" xmlns:ds="${DS_NS}" Id="xadesSignedProperties"><xades:SignedSignatureProperties><xades:SigningTime>${formatSigningTime()}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="${SHA256_DIGEST_URI}"/><ds:DigestValue>${certificate.digestValue}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName>${certificate.issuerName}</ds:X509IssuerName><ds:X509SerialNumber>${certificate.serialNumber}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties>`;
}

function buildSignedInfo(invoiceHash: string, signedPropertiesDigest: string): string {
  return `<ds:SignedInfo xmlns:ds="${DS_NS}" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><ds:CanonicalizationMethod Algorithm="${C14N11_URI}"/><ds:SignatureMethod Algorithm="${ECDSA_SHA256_URI}"/><ds:Reference Id="invoiceSignedData" URI=""><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath></ds:Transform><ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath></ds:Transform><ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath></ds:Transform><ds:Transform Algorithm="${C14N11_URI}"/></ds:Transforms><ds:DigestMethod Algorithm="${SHA256_DIGEST_URI}"/><ds:DigestValue>${invoiceHash}</ds:DigestValue></ds:Reference><ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties"><ds:DigestMethod Algorithm="${SHA256_DIGEST_URI}"/><ds:DigestValue>${signedPropertiesDigest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
}

function signSignedInfo(canonicalSignedInfo: string, privateKeyPem: string): string {
  const signer = crypto.createSign('SHA256');
  signer.update(canonicalSignedInfo, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

function buildSignatureXml(
  signedInfoXml: string,
  signatureValue: string,
  certificateBase64: string,
  signedPropertiesXml: string,
): string {
  const signedPropertiesBody = signedPropertiesXml.replace(
    /^<xades:SignedProperties[^>]*>/,
    '<xades:SignedProperties Id="xadesSignedProperties">',
  );
  return `<ds:Signature xmlns:ds="${DS_NS}" Id="signature">${signedInfoXml}<ds:SignatureValue>${signatureValue}</ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificateBase64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo><ds:Object><xades:QualifyingProperties xmlns:xades="${XADES_NS}" Target="signature">${signedPropertiesBody}</xades:QualifyingProperties></ds:Object></ds:Signature>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sign a ZATCA invoice XML with ECDSA-SHA256.
 *
 * Pipeline:
 * 1. Compute invoice hash (without UBLExtensions) for QR and hash chain
 * 2. Use xml-crypto to build XML-DSig structure (references, transforms, SignedInfo)
 * 3. Override signing step to use ECDSA-SHA256 with IEEE-P1363 encoding
 * 4. Build UBL DocumentSignatures wrapper
 * 5. Replace empty UBLExtensions with signed version
 */
export function signInvoice(params: SignParams): SignResult {
  try {
    const { xml, privateKeyPem, certificatePem, qrData } = params;
    getUblRoot(xml);

    if (!/<ext:UBLExtensions\b[\s\S]*?<\/ext:UBLExtensions>/.test(xml)) {
      throw new Error('Invoice XML must contain ext:UBLExtensions placeholder');
    }

    const publicKey = extractQrPublicKey(certificatePem, privateKeyPem);

    const certBase64 = certificatePem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');
    const certificateInfo = getCertificateInfo(certificatePem);

    const qrElement = (qrBase64: string) => `<cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qrBase64}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>`;

    const insertQr = (xmlWithSignature: string, qrBase64: string): string => {
      const withoutExistingQr = xmlWithSignature.replace(
        /<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/,
        '',
      );
      const insertionPoint = withoutExistingQr.indexOf('<cac:AdditionalDocumentReference');
      const signaturePoint = withoutExistingQr.indexOf('<cac:Signature>');
      const element = qrElement(qrBase64);
      if (insertionPoint !== -1) {
        return withoutExistingQr.slice(0, insertionPoint) + element + withoutExistingQr.slice(insertionPoint);
      }
      if (signaturePoint !== -1) {
        return withoutExistingQr.slice(0, signaturePoint) + element + withoutExistingQr.slice(signaturePoint);
      }
      throw new Error('Unable to embed ZATCA QR: missing AdditionalDocumentReference or Signature anchor');
    };

    const buildSignedXml = (invoiceHash: string): SignResult => {
      const signedPropertiesXml = buildSignedProperties(certificateInfo);
      const signedPropertiesDigest = hashForDigestValue(canonicalizeXml(signedPropertiesXml));
      const signedInfoXml = buildSignedInfo(invoiceHash, signedPropertiesDigest);
      const canonicalSignedInfo = canonicalizeXml(signedInfoXml);
      const signatureValue = signSignedInfo(canonicalSignedInfo, privateKeyPem);
      const signatureXml = buildSignatureXml(signedInfoXml, signatureValue, certBase64, signedPropertiesXml);
      const ublSignature = buildUBLSignatureBlock(signatureXml);
      let signedXml = xml.replace(
        /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/,
        `<ext:UBLExtensions>${ublSignature}</ext:UBLExtensions>`,
      );

      if (qrData) {
        signedXml = insertQr(
          signedXml,
          generatePhase2TLVForQr({
            sellerName: qrData.sellerName,
            vatNumber: qrData.vatNumber,
            timestamp: qrData.timestamp,
            totalWithVat: qrData.totalWithVat,
            vatTotal: qrData.vatTotal,
            invoiceHash,
            signatureValue,
            publicKey,
            certificateSignature: qrData.certificateSignature,
          }),
        );
      }

      return { signedXml, invoiceHash, signatureValue };
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
 * Compute SHA-256 hash of invoice XML (without UBLExtensions content and QR).
 *
 * This hash is used for:
 * - Hash chain (Previous Invoice Hash — PIH)
 * - QR code Tag 6 (invoiceHash)
 * - API body `invoiceHash` field
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
export function computeInvoiceHashBase64(xml: string): string {
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
  const canonical = canonicalizer.Canonicalize(doc as unknown as Node) as string;

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
    // Extract SignatureValue
    const sigMatch = signedXml.match(
      /<ds:SignatureValue[^>]*>([^<]+)<\/ds:SignatureValue>/,
    );
    if (!sigMatch) return false;

    // Remove the Signature element to get original content
    const xmlWithoutSig = signedXml
      .replace(/<ds:Signature[^>]*>[\s\S]*?<\/ds:Signature>/g, '')
      .replace(/<ext:UBLExtension>[\s\S]*?<\/ext:UBLExtension>/g, '');

    // Canonicalize
    const canonical = xmlWithoutSig.replace(/>\s+</g, '><').trim();

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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the UBL DocumentSignatures wrapper around the xml-crypto Signature.
 *
 * ZATCA requires the XML-DSig Signature to be nested inside:
 *   ext:UBLExtensions > ext:UBLExtension > ext:ExtensionContent
 *     > sig:UBLDocumentSignatures > sac:SignatureInformation
 */
function buildUBLSignatureBlock(signatureXml: string): string {
  return `    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2"
                                   xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
                                   xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2"
                                   xmlns:ds="${DS_NS}">
          <sac:SignatureInformation>
            <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>
            <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
            ${signatureXml}
          </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>`;
}
