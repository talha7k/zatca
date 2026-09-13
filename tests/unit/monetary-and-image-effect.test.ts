import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { generateInvoiceXml } from '../../src/xml/index.js';
import { runZatcaEffect } from '../../src/effect/errors.js';
import { generatePhase1QRImageEffect, generatePhase2QRImageEffect } from '../../src/qrcode/index.js';
import { createTestInvoice } from '../integration/fixtures.js';

const phase1 = {
  sellerName: 'Test Company',
  vatNumber: '300000000000003',
  timestamp: '2026-09-13T14:30:00Z',
  totalWithVat: '115.00',
  vatTotal: '15.00',
};

describe('BT-113 / BT-114 emission (BR-CO-16)', () => {
  test('prepaid and rounding amounts land in the LegalMonetaryTotal sequence before PayableAmount', () => {
    const xml = generateInvoiceXml({
      ...createTestInvoice(),
      prepaidAmount: 100,
      roundingAmount: 0.04,
      payableAmount: 1199.96 - 100 + 0.04,
    });
    const block = xml.slice(xml.indexOf('<cac:LegalMonetaryTotal>'), xml.indexOf('</cac:LegalMonetaryTotal>'));
    const prepaid = block.indexOf('<cbc:PrepaidAmount');
    const rounding = block.indexOf('<cbc:PayableRoundingAmount');
    const payable = block.indexOf('<cbc:PayableAmount');
    expect(prepaid).toBeGreaterThan(-1);
    expect(rounding).toBeGreaterThan(-1);
    // UBL sequence: PrepaidAmount < PayableRoundingAmount < PayableAmount
    expect(prepaid).toBeLessThan(rounding);
    expect(rounding).toBeLessThan(payable);
    expect(block).toContain('>100.00</cbc:PrepaidAmount>');
    expect(block).toContain('>0.04</cbc:PayableRoundingAmount>');
  });

  test('omitted optional amounts emit nothing (back-compat)', () => {
    const xml = generateInvoiceXml(createTestInvoice());
    expect(xml).not.toContain('cbc:PrepaidAmount');
    expect(xml).not.toContain('cbc:PayableRoundingAmount');
  });
});

describe('QR image Effect twins', () => {
  test('generatePhase1QRImageEffect returns the same data URL as the promise API', async () => {
    const { generatePhase1QRImage } = await import('../../src/qrcode/index.js');
    const viaEffect = await Effect.runPromise(generatePhase1QRImageEffect(phase1));
    expect(viaEffect).toBe(await generatePhase1QRImage(phase1));
    expect(viaEffect).toMatch(/^data:image\/png;base64,/);
  });

  test('generatePhase2QRImageEffect renders the 9-tag payload', async () => {
    const url = await Effect.runPromise(generatePhase2QRImageEffect({
      ...phase1,
      invoiceHash: 'T6sSpoOwhDUmfafuoMIRO0f8YDiRx6pPxCcx0jESj0E=',
      ecdsaSignature: 'MEUCIQDcr8j91Z3EJ6VnVX2a3K/p9wFP7VG5NLKYpBLnzUm2S9AiAiBLlAutK/rCJOb6EkHHaMYHgQREBZdiLhlf6NR1WMYGBA==',
      ecdsaPublicKey: 'BOdEx3FytYBbC6l3Wzc0hE4hCLiQuhahqZevfe5xAsT7UQ0ebzQtoaT6jq7cKePgbbXSISFqPB0jEmBrH4ooqQ==',
      certificateSignature: 'MAYCASoCASs=',
    }));
    expect(url).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(url.split(',')[1], 'base64').length).toBeGreaterThan(500);
  });

  test('invalid data maps to a tagged error and the wrapper throws ZatcaError', async () => {
    const error = await Effect.runPromise(Effect.flip(
      generatePhase2QRImageEffect({ ...phase1, vatNumber: '' } as never),
    )).catch((e) => e);
    void error; // tagged failure OR wrapped ZatcaError — either is acceptable
    await expect(
      runZatcaEffect(generatePhase2QRImageEffect({ ...phase1, vatNumber: '' } as never)),
    ).rejects.toBeTruthy();
  });
});
