/**
 * Type augmentations for xml-crypto v3.2.1
 *
 * xml-crypto's published .d.ts is incomplete — several runtime methods
 * on SignedXml are missing from the type declarations. We augment the
 * interface here so TypeScript knows they exist.
 */

import 'xml-crypto';

declare module 'xml-crypto' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface SignedXml {
    /**
     * Get the canonicalized XML of the SignedInfo element.
     * Used internally by calculateSignatureValue and for manual signing.
     */
    getCanonSignedInfoXml(signedInfo: Node): string;

    /**
     * Calculate the signature value over the canonicalized SignedInfo.
     * Can be overridden to use custom signing algorithms (e.g. ECDSA).
     */
    calculateSignatureValue(doc: Node, callback?: (err: Error | null, signature?: string) => void): void;
  }
}
