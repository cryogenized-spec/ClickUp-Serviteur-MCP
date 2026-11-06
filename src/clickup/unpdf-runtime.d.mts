/** Application-specific PDF.js boundary; third-party runtime exercised by CI. */
export interface UnpdfDocument {
  readonly numPages: number;
  readonly loadingTask: UnpdfLoadingTask;
}
export interface UnpdfLoadingTask {
  readonly promise: Promise<UnpdfDocument>;
  destroy(): Promise<void>;
}
export interface UnpdfModule {
  getDocument(options: {
    data: Uint8Array;
    maxImageSize: number;
    stopAtErrors: boolean;
    useSystemFonts: boolean;
    isEvalSupported: boolean;
  }): UnpdfLoadingTask;
}
export declare function getResolvedPDFJS(): Promise<UnpdfModule>;
export declare function extractText(
  pdf: UnpdfDocument,
): Promise<{ totalPages: number; text: string | string[] }>;
