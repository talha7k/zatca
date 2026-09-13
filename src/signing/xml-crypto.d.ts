/**
 * Type augmentations for xml-crypto v3.2.1
 */

import 'xml-crypto';

declare module 'xml-crypto' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface SignedXml {
    getCanonSignedInfoXml(signedInfo: Node): string;
    calculateSignatureValue(doc: Node, callback?: (err: Error | null, signature?: string) => void): void;
  }
}
