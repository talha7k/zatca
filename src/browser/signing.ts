import { Effect } from 'effect';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import { toZatcaEffectError, type ZatcaEffectError } from '../effect/errors.js';
import type { ExternalSignerResult, QRInvoiceData, ZatcaExternalSigner } from '../signing/index.js';
import {
  assembleSignedXml,
  buildPhase2QrTlvBytes,
  buildSdkSignedPropertiesDigestXml,
  buildSignatureXmlWithSignedProperties,
  buildSignedInfo,
  canonicalizeXml,
  concatBytes,
  formatSigningTime,
  pemBody,
} from '../signing/shared.js';
import { DOMParser } from '@xmldom/xmldom';
import { XmlCanonicalizer } from 'xmldsigjs';

type CanonicalizerNode = Parameters<XmlCanonicalizer['Canonicalize']>[0];

export type {
  ExternalSignerAlgorithm,
  ExternalSignerInput,
  ExternalSignerResult,
  SignWithExternalSignerParams,
  SignatureEncoding,
  ZatcaExternalSigner,
} from '../signing/index.js';

export interface ZatcaExternalSignerInvoiceInput {
  xml: string;
  certificatePem: string;
  qrData?: QRInvoiceData;
  signer: ZatcaExternalSigner;
}

export interface ZatcaExternalSignerInvoiceResult {
  signedXml: string;
  invoiceHash: string;
  signatureValue: string;
}

type BrowserCryptoKey = unknown;

interface BrowserDigestSubtleCrypto {
  digest(algorithm: 'SHA-256', data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> | ArrayBuffer;
}

interface BrowserSigningSubtleCrypto {
  sign(algorithm: {
    name: 'ECDSA';
    hash: {
      name: 'SHA-256';
    };
  }, key: BrowserCryptoKey, data: Uint8Array): Promise<ArrayBuffer> | ArrayBuffer;
}

export interface WebCryptoExternalSignerInput {
  key: BrowserCryptoKey;
  subtle?: BrowserSigningSubtleCrypto;
}

export interface BrowserCertificateInfo {
  issuerName: string;
  serialNumber: string;
}

export interface SignBrowserInvoiceWithExternalSignerParams {
  xml: string;
  certificatePem: string;
  certificateInfo: BrowserCertificateInfo;
  qrData?: QRInvoiceData;
  signer: ZatcaExternalSigner;
  qrPublicKey: string;
  subtle?: BrowserDigestSubtleCrypto;
}

type BrowserSigningCertificateInfo = BrowserCertificateInfo & { digestValue: string };

interface BrowserSignContext {
  xml: string;
  ublRoot: { name: string };
  certificateBase64: string;
  certificateInfo: BrowserSigningCertificateInfo;
  qrData?: QRInvoiceData;
  publicKey: string;
}

export function assertExternalSigner(signer: ZatcaExternalSigner): ZatcaExternalSigner {
  if (signer.algorithm !== 'ECDSA_SHA256') {
    throw new ZatcaError(`Unsupported external signer algorithm: ${signer.algorithm}`, ZatcaErrorCode.SIGN_ERROR);
  }
  return signer;
}

export function createExternalSignerUnavailableError(): ZatcaError {
  return new ZatcaError('Browser external-signer XMLDSig support has not been wired yet. Use this package surface for non-exportable Web Crypto signer integration.', ZatcaErrorCode.SIGN_ERROR);
}

export async function signBrowserInvoiceWithExternalSigner(params: SignBrowserInvoiceWithExternalSignerParams): Promise<ZatcaExternalSignerInvoiceResult> {
  try {
    const subtle = params.subtle ?? getGlobalSubtleCrypto();
    const context = {
      xml: params.xml,
      ublRoot: getUblRoot(params.xml),
      certificateBase64: pemBody(params.certificatePem),
      certificateInfo: {
        digestValue: await digestCertificate(params.certificatePem, subtle),
        issuerName: params.certificateInfo.issuerName,
        serialNumber: params.certificateInfo.serialNumber,
      },
      qrData: params.qrData,
      publicKey: params.qrPublicKey,
    };
    if (!/<ext:UBLExtensions\b[\s\S]*?<\/ext:UBLExtensions>/.test(params.xml)) {
      throw new Error('Invoice XML must contain ext:UBLExtensions placeholder');
    }
    const sign = assertExternalSigner(params.signer).sign.bind(params.signer);
    const buildSignedXml = async (invoiceHash: string): Promise<ZatcaExternalSignerInvoiceResult> => {
      const signingTime = formatSigningTime();
      const signedPropertiesDigest = await digestSdkSignedProperties(context.certificateInfo, signingTime, subtle);
      const signedInfoXml = buildSignedInfo(invoiceHash, signedPropertiesDigest);
      const canonicalSignedInfo = canonicalizeXml(signedInfoXml);
      const result = await sign({
        algorithm: 'ECDSA_SHA256',
        canonicalSignedInfo: textToBytes(canonicalSignedInfo),
        expectedSignatureEncoding: 'base64_der',
      });
      const signatureValue = assertExternalSignerResult(result);
      return buildSignedXmlWithSignature(context, invoiceHash, signedInfoXml, signatureValue, signingTime);
    };
    let invoiceHash = (await canonicalizeForHash(params.xml, subtle)).hashBase64;
    let signed = await buildSignedXml(invoiceHash);
    const finalHash = (await canonicalizeForHash(signed.signedXml, subtle))
      .hashBase64;
    if (finalHash !== invoiceHash) {
      signed = await buildSignedXml(finalHash);
    }
    return signed;
  } catch (error: any) {
    if (error instanceof ZatcaError)
      throw error;
    throw new ZatcaError(`Failed to sign browser invoice with external signer: ${error.message}`, ZatcaErrorCode.SIGN_ERROR, error);
  }
}

export function createWebCryptoExternalSigner(input: WebCryptoExternalSignerInput): ZatcaExternalSigner {
  const subtle = input.subtle ?? getGlobalSubtleCrypto();
  return {
    algorithm: 'ECDSA_SHA256',
    async sign(signerInput) {
      if (signerInput.algorithm !== 'ECDSA_SHA256') {
        throw new ZatcaError(`Unsupported external signer algorithm: ${signerInput.algorithm}`, ZatcaErrorCode.SIGN_ERROR);
      }
      const rawSignature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, input.key, signerInput.canonicalSignedInfo));
      return {
        signatureValue: bytesToBase64(ieeeP1363ToDerSignature(rawSignature)),
        signatureEncoding: 'base64_der',
      };
    },
  };
}

export function ieeeP1363ToDerSignature(signature: Uint8Array): Uint8Array {
  if (signature.length % 2 !== 0 || signature.length === 0) {
    throw new ZatcaError(`Invalid IEEE P1363 ECDSA signature length: ${signature.length}`, ZatcaErrorCode.SIGN_ERROR);
  }
  const midpoint = signature.length / 2;
  const r = encodeDerInteger(signature.slice(0, midpoint));
  const s = encodeDerInteger(signature.slice(midpoint));
  const bodyLength = r.length + s.length;
  return concatBytes(new Uint8Array([0x30]), encodeDerLength(bodyLength), r, s);
}

function getGlobalSubtleCrypto(): BrowserDigestSubtleCrypto & BrowserSigningSubtleCrypto {
  const cryptoGlobal = globalThis.crypto;
  if (!cryptoGlobal?.subtle) {
    throw createExternalSignerUnavailableError();
  }
  return cryptoGlobal.subtle as BrowserDigestSubtleCrypto & BrowserSigningSubtleCrypto;
}

function getUblRoot(xml: string): { name: string } {
  if (/<Invoice(?:\s|>)/.test(xml))
    return { name: 'Invoice' };
  if (/<CreditNote(?:\s|>)/.test(xml))
    return { name: 'CreditNote' };
  throw new Error('Unsupported UBL document: expected Invoice or CreditNote root element');
}

async function digestCertificate(certificatePem: string, subtle: BrowserDigestSubtleCrypto): Promise<string> {
  const digestHex = bytesToHex(new Uint8Array(await subtle.digest('SHA-256', textToBytes(pemBody(certificatePem)))));
  return bytesToBase64(textToBytes(digestHex));
}

async function hashForDigestValue(canonicalXml: string, subtle: BrowserDigestSubtleCrypto): Promise<string> {
  const digestHex = bytesToHex(new Uint8Array(await subtle.digest('SHA-256', textToBytes(canonicalXml))));
  return bytesToBase64(textToBytes(digestHex));
}

// Runtime base64 codecs for the shared QR TLV builder: validation and
// decoding stay browser-flavored (pure TypeScript, strict alphabet checks)
// exactly as before.
const qrTlvCodecs = {
  assertBase64,
  base64ToBytes,
};

function digestSdkSignedProperties(certificate: BrowserSigningCertificateInfo, signingTime: string, subtle: BrowserDigestSubtleCrypto): Promise<string> {
  return hashForDigestValue(buildSdkSignedPropertiesDigestXml(certificate, signingTime), subtle);
}

function assertExternalSignerResult(result: ExternalSignerResult): string {
  if (result.signatureEncoding !== 'base64_der') {
    throw new Error(`Unsupported external signature encoding: ${result.signatureEncoding}`);
  }
  assertBase64('signatureValue', result.signatureValue);
  return result.signatureValue.trim();
}

function buildSignedXmlWithSignature(context: BrowserSignContext, invoiceHash: string, signedInfoXml: string, signatureValue: string, signingTime: string): ZatcaExternalSignerInvoiceResult {
  const signatureXml = buildSignatureXmlWithSignedProperties(
    signedInfoXml,
    signatureValue,
    context.certificateBase64,
    context.certificateInfo,
    signingTime,
  );
  const finalXml = assembleSignedXml({
    xml: context.xml,
    ublRootName: context.ublRoot.name,
    signatureXml,
    qrBase64: context.qrData
      ? bytesToBase64(buildPhase2QrTlvBytes({
          sellerName: context.qrData.sellerName,
          vatNumber: context.qrData.vatNumber,
          timestamp: context.qrData.timestamp,
          totalWithVat: context.qrData.totalWithVat,
          vatTotal: context.qrData.vatTotal,
          invoiceHash,
          signatureValue,
          publicKey: context.publicKey,
          certificateSignature: context.qrData.certificateSignature,
        }, qrTlvCodecs))
      : undefined,
  });
  return { signedXml: finalXml, invoiceHash, signatureValue };
}

async function canonicalizeForHash(xml: string, subtle: BrowserDigestSubtleCrypto, stripQR = true): Promise<{ canonical: string; hashBase64: string }> {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const ublExts = doc.getElementsByTagNameNS('urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2', 'UBLExtensions');
  for (let index = ublExts.length - 1; index >= 0; index -= 1) {
    ublExts[index].parentNode?.removeChild(ublExts[index]);
  }
  const sigs = doc.getElementsByTagNameNS('urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2', 'Signature');
  for (let index = sigs.length - 1; index >= 0; index -= 1) {
    sigs[index].parentNode?.removeChild(sigs[index]);
  }
  if (stripQR) {
    const docRefs = doc.getElementsByTagNameNS('urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2', 'AdditionalDocumentReference');
    for (let index = docRefs.length - 1; index >= 0; index -= 1) {
      const idEl = docRefs[index].getElementsByTagNameNS('urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2', 'ID')[0];
      if (idEl?.textContent === 'QR') {
        docRefs[index].parentNode?.removeChild(docRefs[index]);
      }
    }
  }
  const canonicalizer = new XmlCanonicalizer(false, false);
  const canonical = canonicalizer.Canonicalize(doc as unknown as CanonicalizerNode) as string;
  const hashBytes = new Uint8Array(await subtle.digest('SHA-256', textToBytes(canonical)));
  return {
    canonical,
    hashBase64: bytesToBase64(hashBytes),
  };
}

function assertBase64(fieldName: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    return trimmed;
  if (bytesToBase64(base64ToBytes(fieldName, trimmed)).replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
    throw new Error(`${fieldName} must be valid base64`);
  }
  return trimmed;
}

function base64ToBytes(fieldName: string, value: string): Uint8Array {
  const clean = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new Error(`${fieldName} must be valid base64`);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean.replace(/=+$/, '')) {
    const index = alphabet.indexOf(char);
    if (index === -1)
      throw new Error(`${fieldName} must be valid base64`);
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function textToBytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function encodeDerInteger(bytes: Uint8Array): Uint8Array {
  const trimmed = trimLeadingZeroes(bytes);
  const needsPositivePadding = (trimmed[0] & 0x80) !== 0;
  const value = needsPositivePadding
    ? concatBytes(new Uint8Array([0x00]), trimmed)
    : trimmed;
  return concatBytes(new Uint8Array([0x02]), encodeDerLength(value.length), value);
}

function trimLeadingZeroes(bytes: Uint8Array): Uint8Array {
  let index = 0;
  while (index < bytes.length - 1 && bytes[index] === 0) {
    index += 1;
  }
  return bytes.slice(index);
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const triplet = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    output += alphabet[(triplet >> 18) & 0x3f];
    output += alphabet[(triplet >> 12) & 0x3f];
    output += alphabet[(triplet >> 6) & 0x3f];
    output += alphabet[triplet & 0x3f];
  }
  if (index < bytes.length) {
    const byteA = bytes[index];
    const byteB = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const triplet = (byteA << 16) | (byteB << 8);
    output += alphabet[(triplet >> 18) & 0x3f];
    output += alphabet[(triplet >> 12) & 0x3f];
    output += index + 1 < bytes.length
      ? alphabet[(triplet >> 6) & 0x3f]
      : '=';
    output += '=';
  }
  return output;
}

// ---------------------------------------------------------------------------
// Effect twin
// ---------------------------------------------------------------------------

/**
 * Effect twin of {@link signBrowserInvoiceWithExternalSigner}: identical
 * browser signing pipeline with tagged-error failure channel.
 */
export const signBrowserInvoiceWithExternalSignerEffect = Effect.fn('signBrowserInvoiceWithExternalSignerEffect')(
  function* (
    params: SignBrowserInvoiceWithExternalSignerParams,
  ): Effect.fn.Return<ZatcaExternalSignerInvoiceResult, ZatcaEffectError> {
    return yield* Effect.tryPromise({
      try: () => signBrowserInvoiceWithExternalSigner(params),
      catch: toZatcaEffectError,
    });
  },
);
