/**
 * XML Digital Signature for ZATCA invoices
 *
 * Uses xml-crypto for XML-DSig structure (references, transforms, canonicalization)
 * with ECDSA-SHA256 signing via Node.js crypto.
 *
 * Why override xml-crypto's signing? xml-crypto v3 only supports RSA signature
 * algorithms natively. ZATCA requires ECDSA-SHA256. We override
 * `calculateSignatureValue` to use Node.js `crypto.createSign('sha256')` with
 * IEEE-P1363 DSA encoding (raw r||s concatenation as specified by XML-DSig).
 *
 * ZATCA requirements:
 * - Signature algorithm: ECDSA-SHA256
 * - Canonicalization: Exclusive XML Canonicalization (exc-c14n)
 * - Digest: SHA-256
 * - Signature placement: ext:UBLExtensions > ext:UBLExtension > ext:ExtensionContent
 */

import crypto from 'crypto';
import { SignedXml } from 'xml-crypto';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignParams {
  /** Raw UBL 2.1 XML string (with empty ext:UBLExtensions placeholder) */
  xml: string;
  /** ECDSA private key in PEM format */
  privateKeyPem: string;
  /** X.509 certificate in PEM format (ZATCA CSID certificate) */
  certificatePem: string;
}

export interface SignResult {
  /** Signed XML with ECDSA signature embedded in UBLExtensions */
  signedXml: string;
  /** SHA-256 hex hash of the invoice (for hash chain PIH and QR Tag 6) */
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
    const { xml, privateKeyPem, certificatePem } = params;

    // 1. Compute invoice hash (without UBLExtensions) for QR and hash chain
    const invoiceHash = computeInvoiceHash(xml);

    // 2. Extract certificate base64 (strip PEM headers and whitespace)
    const certBase64 = certificatePem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');

    // 3. Create SignedXml instance
    const sig = new SignedXml();

    // Set the signing key (xml-crypto stores it for calculateSignatureValue)
    sig.signingKey = privateKeyPem;

    // Set key info provider — injects X509Certificate into KeyInfo
    sig.keyInfoProvider = {
      getKey: () => Buffer.from(''),
      getKeyInfo: () =>
        `<ds:X509Data><ds:X509Certificate>${certBase64}</ds:X509Certificate></ds:X509Data>`,
    };

    // Add reference — sign the entire Invoice element
    // Transforms: enveloped-signature (removes Signature before digesting)
    //             + exc-c14n (canonicalize for consistent hashing)
    sig.addReference(
      "//*[local-name(.)='Invoice']",
      [ENVELOPED_SIGNATURE_URI, EXC_C14N_URI],
      SHA256_DIGEST_URI,
    );

    // Canonicalization algorithm for SignedInfo
    sig.canonicalizationAlgorithm = EXC_C14N_URI;

    // Signature algorithm URI — written into SignedInfo XML
    // (actual crypto is handled by our override, not xml-crypto's RSA impl)
    sig.signatureAlgorithm = ECDSA_SHA256_URI;

    // 4. Compute signature with ECDSA override
    computeECDSASignature(sig, xml, privateKeyPem);

    // 5. Extract the <ds:Signature> element
    const signatureXml = sig.getSignatureXml();

    // 6. Extract signature value for QR code (Tag 7)
    const sigValueMatch = signatureXml.match(
      /<ds:SignatureValue[^>]*>([^<]+)<\/ds:SignatureValue>/,
    );
    const signatureValue = sigValueMatch?.[1] ?? '';

    // 7. Build UBL DocumentSignatures wrapper
    const ublSignature = buildUBLSignatureBlock(signatureXml);

    // 8. Replace empty UBLExtensions with signed version
    const signedXml = xml.replace(
      /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/,
      `<ext:UBLExtensions>${ublSignature}</ext:UBLExtensions>`,
    );

    return { signedXml, invoiceHash, signatureValue };
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
 * Compute SHA-256 hash of invoice XML (without UBLExtensions content).
 *
 * This hash is used for:
 * - Hash chain (Previous Invoice Hash — PIH)
 * - QR code Tag 6 (invoiceHash)
 *
 * The UBLExtensions block is emptied before hashing because the signature
 * itself should not be part of the signed content — it's a circular dependency.
 */
export function computeInvoiceHash(xml: string): string {
  // Remove UBLExtensions content (replace with empty element)
  const xmlWithoutExt = xml.replace(
    /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/,
    '<ext:UBLExtensions></ext:UBLExtensions>',
  );

  // Normalize whitespace (consistent canonicalization)
  const canonical = xmlWithoutExt
    .replace(/>\s+</g, '><')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
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
 * Override xml-crypto's signing step to use ECDSA-SHA256.
 *
 * xml-crypto v3 only supports RSA algorithms. We monkey-patch
 * `calculateSignatureValue` to:
 * 1. Get the canonicalized SignedInfo (xml-crypto handles this correctly)
 * 2. Sign with Node.js crypto using ECDSA-SHA256 + IEEE-P1363 encoding
 * 3. Set `this.signatureValue` so xml-crypto can build the complete Signature
 */
function computeECDSASignature(
  sig: SignedXml,
  xml: string,
  privateKeyPem: string,
): void {
  // Save original method for cleanup
  const originalCalculate = sig.calculateSignatureValue.bind(sig);

  // Override: use ECDSA-SHA256 with IEEE-P1363 DSA encoding
  sig.calculateSignatureValue = function (doc: Node): void {
    const signedInfoCanon: string = sig.getCanonSignedInfoXml(doc);

    const signer = crypto.createSign('sha256');
    signer.update(signedInfoCanon);

    // IEEE-P1363: raw r||s concatenation (required by XML-DSig ECDSA spec)
    (sig as any).signatureValue = signer.sign(
      { key: privateKeyPem, dsaEncoding: 'ieee-p1363' },
      'base64',
    );
  };

  try {
    sig.computeSignature(xml, {
      prefix: 'ds',
      existingPrefixes: {
        '': 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
        cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
        cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
        ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
      },
    });
  } finally {
    // Restore original method
    sig.calculateSignatureValue = originalCalculate;
  }
}

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
                                   xmlns:ds="${DS_NS}">
          <sac:SignatureInformation>
            <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>
            <sac:ReferencedSignatureID>
              <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:Signature</cbc:ID>
            </sac:ReferencedSignatureID>
            ${signatureXml}
          </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>`;
}
