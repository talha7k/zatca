/**
 * Type declarations for the optional `qrcode` peer dependency.
 *
 * Only the `toDataURL` function is declared — this is the only API used
 * by `src/qrcode/image.ts`. If you need more, install `@types/qrcode`.
 */

declare module 'qrcode' {
  interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: {
      dark?: string;
      light?: string;
    };
  }

  function toDataURL(
    text: string,
    options?: QRCodeToDataURLOptions,
  ): Promise<string>;

  export { toDataURL };
}
