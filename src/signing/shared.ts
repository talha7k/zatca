/**
 * Shared XML-DSig/XAdES assembly helpers for ZATCA invoice signing.
 *
 * Used by BOTH the Node signing path (src/signing/sign.ts) and the browser
 * external-signer path (src/browser/signing.ts).
 *
 * BROWSER-SAFE by contract: pure TypeScript only — no node:crypto, no Buffer,
 * no fs. Byte-level helpers operate on Uint8Array; base64 encode/validate
 * codecs are injected by each caller so the two runtimes keep their own
 * exact validation and encoding behavior.
 */

import { DOMParser } from '@xmldom/xmldom';
import { XmlCanonicalizer } from 'xmldsigjs';

type CanonicalizerNode = Parameters<XmlCanonicalizer['Canonicalize']>[0];

// ---------------------------------------------------------------------------
// Namespaces and algorithm URIs
// ---------------------------------------------------------------------------

const ECDSA_SHA256_URI = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';
const C14N11_URI = 'http://www.w3.org/2006/12/xml-c14n11';
const SHA256_DIGEST_URI = 'http://www.w3.org/2001/04/xmlenc#sha256';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const XADES_NS = 'http://uri.etsi.org/01903/v1.3.2#';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Certificate facts needed to build XAdES SignedProperties. */
export interface CertificateInfoFragment {
  digestValue: string;
  issuerName: string;
  serialNumber: string;
}

/** Base64 encode/validate codecs injected by each runtime. */
export interface Base64Codecs {
  /** Validate a base64 field (throwing `${fieldName} must be valid base64`) and return the trimmed value. */
  assertBase64(fieldName: string, value: string): string;
  /** Decode a validated base64 field to bytes. */
  base64ToBytes(fieldName: string, value: string): Uint8Array;
}

/** Caller-supplied data for the Phase 2 QR TLV (Tags 1-9). */
export interface QrTlvInput {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  totalWithVat: string;
  vatTotal?: string;
  invoiceHash: string;
  signatureValue: string;
  publicKey: string;
  certificateSignature: string;
}

// ---------------------------------------------------------------------------
// Small pure utilities
// ---------------------------------------------------------------------------

/** Strip milliseconds from an ISO timestamp: ZATCA signing time format. */
export function formatSigningTime(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

/** Canonical XML 1.1 canonicalization (compatible implementation). */
export function canonicalizeXml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const canonicalizer = new XmlCanonicalizer(false, false);
  return canonicalizer.Canonicalize(doc as unknown as CanonicalizerNode) as string;
}

/** Strip the PEM armor and whitespace from a certificate, leaving base64 DER. */
export function pemBody(certificatePem: string): string {
  return certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
}

// ---------------------------------------------------------------------------
// XML-DSig / XAdES XML builders
// ---------------------------------------------------------------------------

/** Build the xades:SignedProperties XML for the X509 certificate. */
function buildSignedProperties(certificate: CertificateInfoFragment, signingTime: string): string {
  return `<xades:SignedProperties xmlns:xades="${XADES_NS}" xmlns:ds="${DS_NS}" Id="xadesSignedProperties"><xades:SignedSignatureProperties><xades:SigningTime>${signingTime}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="${SHA256_DIGEST_URI}"/><ds:DigestValue>${certificate.digestValue}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName>${certificate.issuerName}</ds:X509IssuerName><ds:X509SerialNumber>${certificate.serialNumber}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties>`;
}

/**
 * Build the SignedProperties XML exactly the way the ZATCA SDK digests it
 * (namespace declarations moved onto the individual ds: elements).
 */
export function buildSdkSignedPropertiesDigestXml(certificate: CertificateInfoFragment, signingTime: string): string {
  return `<xades:SignedProperties xmlns:xades="${XADES_NS}" Id="xadesSignedProperties"><xades:SignedSignatureProperties><xades:SigningTime>${signingTime}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod xmlns:ds="${DS_NS}" Algorithm="${SHA256_DIGEST_URI}"/><ds:DigestValue xmlns:ds="${DS_NS}">${certificate.digestValue}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName xmlns:ds="${DS_NS}">${certificate.issuerName}</ds:X509IssuerName><ds:X509SerialNumber xmlns:ds="${DS_NS}">${certificate.serialNumber}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties>`;
}

/** Build the ds:SignedInfo XML with the ZATCA exclusion transforms. */
export function buildSignedInfo(invoiceHash: string, signedPropertiesDigest: string): string {
  return `<ds:SignedInfo xmlns:ds="${DS_NS}" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><ds:CanonicalizationMethod Algorithm="${C14N11_URI}"/><ds:SignatureMethod Algorithm="${ECDSA_SHA256_URI}"/><ds:Reference Id="invoiceSignedData" URI=""><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath></ds:Transform><ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath></ds:Transform><ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath></ds:Transform><ds:Transform Algorithm="${C14N11_URI}"/></ds:Transforms><ds:DigestMethod Algorithm="${SHA256_DIGEST_URI}"/><ds:DigestValue>${invoiceHash}</ds:DigestValue></ds:Reference><ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties"><ds:DigestMethod Algorithm="${SHA256_DIGEST_URI}"/><ds:DigestValue>${signedPropertiesDigest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
}

/** Build the ds:Signature XML wrapping SignedInfo, signature value, cert and SignedProperties. */
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

/** Convenience: ds:Signature XML with SignedProperties built from certificate info. */
export function buildSignatureXmlWithSignedProperties(
  signedInfoXml: string,
  signatureValue: string,
  certificateBase64: string,
  certificate: CertificateInfoFragment,
  signingTime: string,
): string {
  return buildSignatureXml(
    signedInfoXml,
    signatureValue,
    certificateBase64,
    buildSignedProperties(certificate, signingTime),
  );
}

/**
 * Build the UBL DocumentSignatures wrapper around the ds:Signature.
 *
 * ZATCA requires the XML-DSig Signature to be nested inside:
 *   ext:UBLExtensions > ext:UBLExtension > ext:ExtensionContent
 *     > sig:UBLDocumentSignatures > sac:SignatureInformation
 */
function buildUBLSignatureBlock(signatureXml: string, documentName: string): string {
  return `    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2"
                                   xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
                                   xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2"
                                   xmlns:ds="${DS_NS}">
          <sac:SignatureInformation>
            <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>
            <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:${documentName}</sbc:ReferencedSignatureID>
            ${signatureXml}
          </sac:SignatureInformation>
        </sig:UBLDocumentSignatures>
      </ext:ExtensionContent>
    </ext:UBLExtension>`;
}

// ---------------------------------------------------------------------------
// QR embedding
// ---------------------------------------------------------------------------

/** Build the cac:AdditionalDocumentReference element embedding the QR payload. */
function qrElement(qrBase64: string): string {
  return `<cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qrBase64}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>`;
}

/**
 * Insert (or replace) the QR AdditionalDocumentReference in signed XML.
 *
 * Prefers the position before the first AdditionalDocumentReference, falls
 * back to before cac:Signature, and throws when neither anchor exists.
 */
export function insertQr(xmlWithSignature: string, qrBase64: string): string {
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
}

/**
 * Final signing assembly: splice the UBL signature block into the
 * ext:UBLExtensions placeholder and, when a QR payload is supplied, embed it.
 */
export function assembleSignedXml(params: {
  xml: string;
  ublRootName: string;
  signatureXml: string;
  qrBase64?: string;
}): string {
  const ublSignature = buildUBLSignatureBlock(params.signatureXml, params.ublRootName);
  let signedXml = params.xml.replace(
    /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/,
    `<ext:UBLExtensions>${ublSignature}</ext:UBLExtensions>`,
  );
  if (params.qrBase64 !== undefined) {
    signedXml = insertQr(signedXml, params.qrBase64);
  }
  return signedXml;
}

// ---------------------------------------------------------------------------
// Phase 2 QR TLV encoding (Tags 1-9), Uint8Array-based
// ---------------------------------------------------------------------------

/** Concatenate byte arrays into one Uint8Array. */
export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** DER/TLV length field: short form below 128, then 0x81 and 0x82 long forms. */
function encodeTLVLength(length: number): Uint8Array {
  if (length < 128)
    return new Uint8Array([length]);
  if (length < 256)
    return new Uint8Array([0x81, length]);
  return new Uint8Array([0x82, (length >> 8) & 0xff, length & 0xff]);
}

/** Encode a single TLV record from raw bytes. */
function encodeTLVBytes(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), encodeTLVLength(value.length), value);
}

/** Encode a single TLV record from UTF-8 text. */
function encodeTLVText(tag: number, value: string): Uint8Array {
  return encodeTLVBytes(tag, new TextEncoder().encode(value));
}

/**
 * Build the Phase 2 QR payload bytes: TLV Tags 1-9 as defined by ZATCA.
 *
 * Tags 6/7 (invoice hash, signature) are base64-validated through the
 * caller's `assertBase64` codec; Tags 8/9 (public key, certificate
 * signature) are decoded through the caller's `base64ToBytes` codec —
 * each runtime keeps its own exact validation semantics.
 */
export function buildPhase2QrTlvBytes(data: QrTlvInput, codecs: Base64Codecs): Uint8Array {
  return concatBytes(
    encodeTLVText(1, data.sellerName.trim()),
    encodeTLVText(2, data.vatNumber.trim()),
    encodeTLVText(3, data.timestamp.trim()),
    encodeTLVText(4, data.totalWithVat.trim()),
    encodeTLVText(5, (data.vatTotal || '0.00').trim()),
    encodeTLVText(6, codecs.assertBase64('invoiceHash', data.invoiceHash)),
    encodeTLVText(7, codecs.assertBase64('signatureValue', data.signatureValue)),
    encodeTLVBytes(8, codecs.base64ToBytes('publicKey', data.publicKey)),
    encodeTLVBytes(9, codecs.base64ToBytes('certificateSignature', data.certificateSignature)),
  );
}
