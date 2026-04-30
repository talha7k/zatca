/**
 * XML Digital Signature for ZATCA invoices
 *
 * Uses xml-crypto for XML-DSig structure (references, transforms, canonicalization)
 * with ECDSA-SHA256 signing via Node.js crypto.
 *
 * xml-crypto v3 only supports RSA signature algorithms natively. We register
 * a custom ECDSA-SHA256 algorithm that uses Node.js `crypto.createSign('sha256')`
 * with IEEE-P1363 DSA encoding (raw r||s concatenation as specified by XML-DSig).
 *
 * ZATCA requirements:
 * - Signature algorithm: ECDSA-SHA256
 * - Canonicalization: Exclusive XML Canonicalization (exc-c14n)
 * - Digest: SHA-256
 * - Signature placement: ext:UBLExtensions > ext:UBLExtension > ext:ExtensionContent
 */

import crypto from 'crypto';

import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';

import { XmlCanonicalizer } from 'xmldsigjs';

// ---------------------------------------------------------------------------
// Register ECDSA-SHA256 with xml-crypto (it only supports RSA by default)
// ---------------------------------------------------------------------------

/**
 * ECDSA-SHA256 signature algorithm for xml-crypto.
 * Uses IEEE-P1363 encoding (raw r||s concatenation) as required by XML-DSig.
 */
class ECDSASHA256 {
  getSignature(signedInfo: string, signingKey: string, callback?: (err: Error | null, result?: string) => void): string {
    const signer = crypto.createSign('SHA256');
    signer.update(signedInfo);
    const res = signer.sign({ key: signingKey, dsaEncoding: 'ieee-p1363' }, 'base64');
    if (callback) callback(null, res);
    return res;
  }

  verifySignature(str: string, key: string, signatureValue: string, callback?: (err: Error | null, result?: boolean) => void): boolean {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(str);
    verifier.end();
    const res = verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, signatureValue, 'base64');
    if (callback) callback(null, res);
    return res;
  }

  getAlgorithmName(): string {
    return 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';
  }
}

// Register at module load time
SignedXml.SignatureAlgorithms['http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256'] = ECDSASHA256 as any;

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
const EXC_C14N_URI = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED_SIGNATURE_URI = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SHA256_DIGEST_URI = 'http://www.w3.org/2001/04/xmlenc#sha256';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';

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

function extractQrPublicKey(certificatePem: string, privateKeyPem: string): string {
  try {
    const cert = new crypto.X509Certificate(certificatePem);
    const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
    return spkiDer.toString('base64');
  } catch {
    const spkiDer = crypto
      .createPublicKey(privateKeyPem)
      .export({ type: 'spki', format: 'der' });
    return spkiDer.toString('base64');
  }
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
    const ublRoot = getUblRoot(xml);

    // 1. Canonical hash is recomputed from the exact XML returned below,
    // after signature insertion and before QR insertion. QR is stripped during
    // hash computation, so the returned API hash and QR Tag 6 stay identical.
    canonicalizeForHash(xml);

    // 2. The ECDSA signature for QR Tag 7 is extracted from the XML-DSig
    //    SignatureValue after computeSignature() below. ZATCA requires
    //    QR Tag 7 to match ds:SignatureValue exactly.

    // 3. Extract public key for QR Tag 8
    const rawPublicKey = extractQrPublicKey(certificatePem, privateKeyPem);

    // 4. Extract certificate base64 (strip PEM headers and whitespace)
    const certBase64 = certificatePem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');

    // 5. Create SignedXml instance
    const sig = new SignedXml();
    sig.signingKey = privateKeyPem;
    sig.keyInfoProvider = {
      getKey: () => Buffer.from(''),
      getKeyInfo: () =>
        `<ds:X509Data><ds:X509Certificate>${certBase64}</ds:X509Certificate></ds:X509Data>`,
    };
    sig.addReference(
      `//*[local-name(.)='${ublRoot.name}']`,
      [ENVELOPED_SIGNATURE_URI, EXC_C14N_URI],
      SHA256_DIGEST_URI,
    );
    sig.canonicalizationAlgorithm = EXC_C14N_URI;
    sig.signatureAlgorithm = ECDSA_SHA256_URI;

    // xmldom workaround — same as before
    const cacNs = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
    const cbcNs = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
    const extNs = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';

    let xmlForSigning = xml
      .replace(`<${ublRoot.name} `, `<inv:${ublRoot.name} `)
      .replace('xmlns="', 'xmlns:inv="')
      .replace(`</${ublRoot.name}>`, `</inv:${ublRoot.name}>`);

    sig.computeSignature(xmlForSigning, {
      prefix: 'ds',
      existingPrefixes: {
        inv: ublRoot.namespace,
        cac: cacNs,
        cbc: cbcNs,
        ext: extNs,
      },
    });

    const signatureXml = sig.getSignatureXml();

    // Extract the actual SignatureValue from XML-DSig for QR Tag 7
    const sigValueMatch = signatureXml.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/);
    const xmlDsigSignatureValue = sigValueMatch ? sigValueMatch[1] : '';

    const ublSignature = buildUBLSignatureBlock(signatureXml);

    // Replace empty UBLExtensions with signed version
    let signedXml = xml.replace(
      /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/,
      `<ext:UBLExtensions>${ublSignature}</ext:UBLExtensions>`,
    );
    let invoiceHash = canonicalizeForHash(signedXml).hashBase64;

    const buildQrBase64 = (hashBase64: string): string => {
      if (!qrData) return '';
      return generatePhase2TLVForQr({
        sellerName: qrData.sellerName,
        vatNumber: qrData.vatNumber,
        timestamp: qrData.timestamp,
        totalWithVat: qrData.totalWithVat,
        vatTotal: qrData.vatTotal,
        invoiceHash: hashBase64,
        signatureValue: xmlDsigSignatureValue,
        publicKey: rawPublicKey,
        certificateSignature: qrData.certificateSignature,
      });
    };

    // Generate and embed QR AFTER signing
    if (qrData) {
      // QR element has NO leading indentation — it inherits the whitespace
      // from the insertion point. No trailing newline either, so that
      // removing this element from the DOM leaves the same whitespace as
      // the original XML (critical for hash consistency with ZATCA).
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
        throw new Error('Could not insert QR: missing AdditionalDocumentReference or Signature anchor');
      };

      signedXml = insertQr(signedXml, buildQrBase64(invoiceHash));
      const hashAfterQrInsert = canonicalizeForHash(signedXml).hashBase64;
      if (hashAfterQrInsert !== invoiceHash) {
        invoiceHash = hashAfterQrInsert;
        signedXml = insertQr(signedXml, buildQrBase64(invoiceHash));
      }
    }

    // Return the original invoiceHash (from step 1) which is what's in the QR.
    return { signedXml, invoiceHash, signatureValue: xmlDsigSignatureValue };
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
 * 4. Apply inclusive C14N canonicalization (matching ZATCA invoice hash transform)
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

  // ZATCA invoice hash transform uses canonical XML after removing excluded nodes.
  // XML-DSig SignedInfo still uses exclusive C14N; this hash path intentionally
  // uses inclusive C14N for the API body invoiceHash and QR Tag 6.
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

    // Verify ECDSA-SHA256 signature (IEEE-P1363 encoding)
    const verifier = crypto.createVerify('sha256');
    verifier.update(canonical, 'utf8');
    verifier.end();

    return verifier.verify(
      { key: publicKeyPem, dsaEncoding: 'ieee-p1363' },
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
