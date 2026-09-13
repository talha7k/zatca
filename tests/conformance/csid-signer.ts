/**
 * Shared CSID-backed signing for conformance tests.
 *
 * With a real sandbox CSID fixture (`.zatca-csid.json`, see
 * zatca-sdk.test.ts `loadCsidFixture`), the key curve (secp256k1) is
 * unsupported by Bun's crypto — so signing goes through the library's own
 * external-signer API backed by the openssl CLI, with pre-extracted
 * certificate info and SPKI public key. Without a fixture the caller falls
 * back to the in-process signer.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { signInvoice, signInvoiceWithExternalSigner } from '../../src/signing/index.js';
import type { SignResult, SignWithExternalSignerParams } from '../../src/signing/index.js';

export interface CsidCredentials {
  certificatePem: string;
  privateKeyPem: string;
  certificateSignature: string;
}

function openssl(args: string[], input?: string | Buffer): Buffer {
  return execFileSync('openssl', args, input !== undefined ? { input } : {}) as Buffer;
}

/** Extract issuer DN (RFC2253), decimal serial, and base64 SPKI via openssl. */
export function csidMaterial(csid: CsidCredentials): { issuerName: string; serialNumber: string; qrPublicKey: string } {
  const dir = mkdtempSync(join(tmpdir(), 'csid-material-'));
  try {
    const certPath = join(dir, 'cert.pem');
    writeFileSync(certPath, csid.certificatePem);
    const issuer = openssl(['x509', '-in', certPath, '-noout', '-issuer', '-nameopt', 'RFC2253']).toString().replace(/^issuer=/, '').trim();
    const serialHex = openssl(['x509', '-in', certPath, '-noout', '-serial']).toString().replace(/^serial=/i, '').trim();
    const pemOut = openssl(['x509', '-in', certPath, '-noout', '-pubkey']).toString();
    return {
      issuerName: issuer,
      serialNumber: BigInt(`0x${serialHex}`).toString(10),
      qrPublicKey: pemOut.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sign with an openssl-backed ECDSA signer (DER output). */
export async function signWithCsid(
  params: Omit<SignWithExternalSignerParams, 'signer' | 'qrPublicKey' | 'certificateInfo'>,
  csid: CsidCredentials,
): Promise<SignResult> {
  const material = csidMaterial(csid);
  const dir = mkdtempSync(join(tmpdir(), 'csid-sign-'));
  const keyPath = join(dir, 'key.pem');
  writeFileSync(keyPath, csid.privateKeyPem);
  try {
    return await signInvoiceWithExternalSigner({
      ...params,
      certificatePem: csid.certificatePem,
      qrPublicKey: material.qrPublicKey,
      certificateInfo: { issuerName: material.issuerName, serialNumber: material.serialNumber },
      signer: async (input) => {
        const inPath = join(dir, 'signedinfo.bin');
        writeFileSync(inPath, Buffer.from(input.canonicalSignedInfo));
        const der = openssl(['dgst', '-sha256', '-sign', keyPath, inPath]);
        return { signatureValue: der.toString('base64'), signatureEncoding: 'base64_der' as const };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** In-process signing for the static test key (Bun-native P-256). */
export function signWithTestKey(params: Omit<Parameters<typeof signInvoice>[0], 'privateKeyPem' | 'certificatePem'> & { privateKeyPem: string; certificatePem: string }): SignResult {
  return signInvoice(params);
}
