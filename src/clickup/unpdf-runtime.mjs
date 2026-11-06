/**
 * Runtime boundary for unpdf 1.9.1.
 *
 * Its npm declarations import optional native-canvas and browser DOM types
 * that are not part of this Worker's strict ES/WebWorker tsconfig. This module
 * re-exports only the two serverless parser functions the Worker uses.
 *
 * TypeScript checks callers via the adjacent .d.mts contract, and Wrangler
 * must still bundle the real pinned npm implementation in strict CI.
 */
import { extractText, getDocumentProxy } from "unpdf";

export { extractText, getDocumentProxy };
