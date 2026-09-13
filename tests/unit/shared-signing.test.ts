import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  assembleSignedXml,
  buildPhase2QrTlvBytes,
  buildSignatureXmlWithSignedProperties,
  buildSignedInfo,
  formatSigningTime,
  insertQr,
  pemBody,
  type Base64Codecs,
} from '../../src/signing/shared.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const SIGNED_XML_WITH_SIGNATURE = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cac:AdditionalDocumentReference><cbc:ID>EXISTING</cbc:ID></cac:AdditionalDocumentReference><cac:Signature>placeholder</cac:Signature><ext:UBLExtensions></ext:UBLExtensions></Invoice>`;

const CERT_INFO = {
  digestValue: 'dGVzdC1kaWdlc3Q=',
  issuerName: 'CN=ZATCA-Code-Signing-CA',
  serialNumber: '123456789',
};

const SIGNING_TIME = '2026-01-15T14:30:00';

/** Buffer-based codecs mirroring the Node signing path. */
const bufferCodecs: Base64Codecs = {
  assertBase64(fieldName, value) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return trimmed;
    const bytes = Buffer.from(trimmed, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
      throw new Error(`${fieldName} must be valid base64`);
    }
    return trimmed;
  },
  base64ToBytes(fieldName, value) {
    return Buffer.from(value.trim(), 'base64');
  },
};

const QR_INPUT = {
  sellerName: 'Test Company',
  vatNumber: '300000000000003',
  timestamp: '2026-01-15T14:30:00Z',
  totalWithVat: '115.00',
  vatTotal: '15.00',
  invoiceHash: 'AACaaQ==', // decodes to 1 byte 0x00 0x01 0x69 → wait: 'AACA aQ' — see reference below
  signatureValue: 'MEUCIQ==',
  publicKey: 'AEE=',
  certificateSignature: 'AQI=',
};

/** Independent reference TLV encoder (test-side only). */
function refTlv(tag: number, value: Uint8Array): Buffer {
  const len = value.length;
  const lengthBytes = len < 128
    ? Buffer.from([len])
    : len < 256
      ? Buffer.from([0x81, len])
      : Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([Buffer.from([tag]), lengthBytes, Buffer.from(value)]);
}

function refTlvText(tag: number, text: string): Buffer {
  return refTlv(tag, Buffer.from(text, 'utf8'));
}

function refQrBase64(input: typeof QR_INPUT): string {
  return Buffer.concat([
    refTlvText(1, input.sellerName.trim()),
    refTlvText(2, input.vatNumber.trim()),
    refTlvText(3, input.timestamp.trim()),
    refTlvText(4, input.totalWithVat.trim()),
    refTlvText(5, (input.vatTotal ?? '0.00').trim()),
    refTlvText(6, input.invoiceHash.trim()),
    refTlvText(7, input.signatureValue.trim()),
    refTlv(8, Buffer.from(input.publicKey.trim(), 'base64')),
    refTlv(9, Buffer.from(input.certificateSignature.trim(), 'base64')),
  ]).toString('base64');
}

// ---------------------------------------------------------------------------
// formatSigningTime
// ---------------------------------------------------------------------------

describe('formatSigningTime (shared)', () => {
  test('strips milliseconds AND the trailing Z (pinned ZATCA signing-time format)', () => {
    expect(formatSigningTime(new Date('2026-01-15T14:30:00.123Z'))).toBe('2026-01-15T14:30:00');
  });

  test('defaults to the current time in Z-less second-precision ISO format', () => {
    const value = formatSigningTime();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// pemBody / insertQr / assembleSignedXml
// ---------------------------------------------------------------------------

describe('pemBody (shared)', () => {
  test('strips PEM armor and whitespace', () => {
    expect(pemBody('-----BEGIN CERTIFICATE-----\nAAEC\nIDA=\n-----END CERTIFICATE-----\n')).toBe('AAECIDA=');
  });
});

describe('insertQr (shared)', () => {
  test('inserts before the first AdditionalDocumentReference when present', () => {
    const xml = '<a><cac:AdditionalDocumentReference><cbc:ID>OTHER</cbc:ID></cac:AdditionalDocumentReference><cac:Signature></cac:Signature></a>';
    const result = insertQr(xml, 'QRDATA');
    expect(result).toContain('<cbc:ID>QR</cbc:ID>');
    expect(result.indexOf('QRDATA')).toBeLessThan(result.indexOf('OTHER'));
  });

  test('falls back to before cac:Signature when no document reference exists', () => {
    const xml = '<a><cac:Signature></cac:Signature></a>';
    const result = insertQr(xml, 'QRDATA');
    expect(result).toBe(`<a><cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">QRDATA</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference><cac:Signature></cac:Signature></a>`);
  });

  test('replaces an existing QR block in place', () => {
    const xml = '<a><cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment>OLD</cac:Attachment></cac:AdditionalDocumentReference><cac:Signature></cac:Signature></a>';
    const result = insertQr(xml, 'NEW');
    expect(result).toContain('NEW');
    expect(result).not.toContain('OLD');
    expect(result.match(/cbc:ID>QR</g)).toHaveLength(1);
  });

  test('throws when neither anchor exists', () => {
    expect(() => insertQr('<a></a>', 'QRDATA')).toThrow(
      'Unable to embed ZATCA QR: missing AdditionalDocumentReference or Signature anchor',
    );
  });
});

describe('assembleSignedXml (shared)', () => {
  const signatureXml = buildSignatureXmlWithSignedProperties(
    buildSignedInfo('INVOICE_HASH', 'PROPS_DIGEST'),
    'SIG',
    'CERTBASE64',
    CERT_INFO,
    SIGNING_TIME,
  );

  test('splices the signature block into the UBLExtensions placeholder', () => {
    const result = assembleSignedXml({
      xml: SIGNED_XML_WITH_SIGNATURE,
      ublRootName: 'Invoice',
      signatureXml,
    });
    expect(result).toContain('<ext:UBLExtensions>    <ext:UBLExtension>');
    expect(result).toContain('<ds:SignatureValue>SIG</ds:SignatureValue>');
    expect(result).toContain('CERTBASE64');
    expect(result).not.toContain('<ext:UBLExtensions></ext:UBLExtensions>');
    expect(result).not.toContain('QRDATA');
  });

  test('embeds the QR payload when a qrBase64 is supplied', () => {
    const result = assembleSignedXml({
      xml: SIGNED_XML_WITH_SIGNATURE,
      ublRootName: 'Invoice',
      signatureXml,
      qrBase64: 'QRDATA',
    });
    expect(result).toContain('QRDATA');
    expect(result.indexOf('QRDATA')).toBeLessThan(result.indexOf('<cbc:ID>EXISTING'));
  });

  test('propagates the insertQr anchor error for XML without anchors', () => {
    const xml = '<Invoice><ext:UBLExtensions></ext:UBLExtensions></Invoice>';
    expect(() =>
      assembleSignedXml({ xml, ublRootName: 'Invoice', signatureXml, qrBase64: 'QRDATA' }),
    ).toThrow('Unable to embed ZATCA QR');
  });

  test('works for CreditNote document names (ReferencedSignatureID)', () => {
    const result = assembleSignedXml({
      xml: SIGNED_XML_WITH_SIGNATURE,
      ublRootName: 'CreditNote',
      signatureXml,
    });
    expect(result).toContain('urn:oasis:names:specification:ubl:signature:CreditNote');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 QR TLV building
// ---------------------------------------------------------------------------

describe('buildPhase2QrTlvBytes (shared)', () => {
  test('matches an independent reference TLV encoding, Tags 1-9', () => {
    const bytes = buildPhase2QrTlvBytes(QR_INPUT, bufferCodecs);
    expect(Buffer.from(bytes).toString('base64')).toBe(refQrBase64(QR_INPUT));
  });

  test('Node codecs (Buffer) and the trimmed/strict codecs produce IDENTICAL TLV bytes', () => {
    // The Node path uses Buffer round-trip validation; the browser path uses
    // a strict alphabet check + manual decoder. For every input both accept,
    // the resulting payload must be byte-identical.
    const trimmedCodecs: Base64Codecs = {
      assertBase64(fieldName, value) {
        const trimmed = value.trim();
        if (trimmed.length === 0) return trimmed;
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 === 1) {
          throw new Error(`${fieldName} must be valid base64`);
        }
        return trimmed;
      },
      base64ToBytes(fieldName, value) {
        return bufferCodecs.base64ToBytes(fieldName, value);
      },
    };
    const a = buildPhase2QrTlvBytes(QR_INPUT, bufferCodecs);
    const b = buildPhase2QrTlvBytes(QR_INPUT, trimmedCodecs);
    expect(Buffer.from(b).toString()).toBe(Buffer.from(a).toString());
  });

  test('throws via the injected assertBase64 codec for invalid Tag 6/7 input', () => {
    expect(() =>
      buildPhase2QrTlvBytes({ ...QR_INPUT, invoiceHash: 'not valid base64!!!' }, bufferCodecs),
    ).toThrow('invoiceHash must be valid base64');
    expect(() =>
      buildPhase2QrTlvBytes({ ...QR_INPUT, signatureValue: '!!!' }, bufferCodecs),
    ).toThrow('signatureValue must be valid base64');
  });

  test('defaults vatTotal to "0.00" when absent', () => {
    const { vatTotal: _omitted, ...withoutVatTotal } = QR_INPUT;
    const bytes = buildPhase2QrTlvBytes(withoutVatTotal, bufferCodecs);
    expect(Buffer.from(bytes).toString('base64')).toBe(refQrBase64(withoutVatTotal));
  });
});

// ---------------------------------------------------------------------------
// Browser-safety contract of the shared module
// ---------------------------------------------------------------------------

describe('shared module browser-safety', () => {
  const source = readFileSync(new URL('../../src/signing/shared.ts', import.meta.url), 'utf8');

  /** Strip block and line comments so doc mentions of "Buffer" don't trip the scan. */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  const codeOnly = stripComments(source);

  test('imports no node builtins', () => {
    expect(codeOnly).not.toMatch(/from\s+'node:/);
    expect(codeOnly).not.toMatch(/from\s+'(crypto|fs|path|os|util)'/);
    expect(codeOnly).not.toMatch(/require\(/);
  });

  test('uses no Buffer in code (Uint8Array only)', () => {
    expect(codeOnly).not.toMatch(/\bBuffer\b/);
  });

  test('only imports browser-safe dependencies', () => {
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const allowed = new Set(['@xmldom/xmldom', 'xmldsigjs']);
    const external = imports.filter((spec) => !spec.startsWith('.'));
    for (const spec of external) {
      expect(allowed.has(spec)).toBe(true);
    }
  });
});
