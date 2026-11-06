/** Narrow, explicit application-facing adapter; not a replacement for library runtime tests. */
export interface UnpdfDocument {
  readonly numPages: number;
  destroy?(): Promise<void>;
}
export declare function getDocumentProxy(
  bytes: Uint8Array,
  options: { maxImageSize: number },
): Promise<UnpdfDocument>;
export declare function extractText(
  pdf: UnpdfDocument,
): Promise<{ totalPages: number; text: string | string[] }>;
