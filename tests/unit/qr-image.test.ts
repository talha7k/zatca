import { describe, expect, test } from 'bun:test';
import { generatePhase1QRImage, generatePhase2QRImage } from '../../src/qrcode/image.js';
import type { Phase1QRData, Phase2QRData } from '../../src/types.js';

const phase1: Phase1QRData = {
  sellerName: 'Test Company',
  vatNumber: '300000000000003',
  timestamp: '2026-09-13T14:30:00Z',
  totalWithVat: '115.00',
  vatTotal: '15.00',
};

const phase2: Phase2QRData = {
  ...phase1,
  invoiceHash: 'T6sSpoOwhDUmfafuoMIRO0f8YDiRx6pPxCcx0jESj0E=',
  ecdsaSignature: 'MEUCIQDcr8j91Z3EJ6VnVX2a3K/p9wFP7VG5NLKYpBLnzUm2S9AiAiBLlAutK/rCJOb6EkHHaMYHgQREBZdiLhlf6NR1WMYGBA==',
  ecdsaPublicKey: 'BOdEx3FytYBbC6l3Wzc0hE4hCLiQuhahqZevfe5xAsT7UQ0ebzQtoaT6jq7cKePgbbXSISFqPB0jEmBrH4ooqQ==',
  certificateSignature: 'MAYCASoCASs=',
};

describe('QR image generation', () => {
  test('generatePhase1QRImage renders a base64 PNG data URL', async () => {
    const url = await generatePhase1QRImage(phase1);
    expect(url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    const bytes = Buffer.from(url.split(',')[1], 'base64');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  test('generatePhase2QRImage renders a PNG large enough for the 9-tag TLV payload', async () => {
    const url = await generatePhase2QRImage(phase2);
    expect(url).toMatch(/^data:image\/png;base64,/);
    // A 9-tag TLV QR renders well above 1KB; Phase 1 payload is smaller.
    const phase2Bytes = Buffer.from(url.split(',')[1], 'base64').length;
    const phase1Bytes = Buffer.from((await generatePhase1QRImage(phase1)).split(',')[1], 'base64').length;
    expect(phase2Bytes).toBeGreaterThan(500);
    expect(phase2Bytes).toBeGreaterThan(phase1Bytes);
  }, 30_000);

  test('options control the rendered size', async () => {
    const small = await generatePhase1QRImage(phase1, { width: 96 });
    const big = await generatePhase1QRImage(phase1, { width: 512 });
    expect(Buffer.from(big.split(',')[1], 'base64').length)
      .toBeGreaterThan(Buffer.from(small.split(',')[1], 'base64').length);
  });
});
