import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parser = vi.hoisted(() => ({
  load: vi.fn(),
  extract: vi.fn(),
}));
vi.mock("../src/clickup/unpdf-runtime.mjs", () => ({
  getResolvedPDFJS: parser.load,
  extractText: parser.extract,
}));

import { extractVerifiedTaskPdf } from "../src/clickup/pdf-reader.js";

const bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic fixture only");
const attachment = {
  id: "safe-qa-file",
  title: "test-only.pdf",
  extension: "pdf",
  mimetype: "application/pdf",
  url: "https://t555.p.clickup-attachments.com/qa.pdf?test=1",
  size: bytes.length,
};
const fetcher = vi.fn(async () => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Response(copy, {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
});

beforeEach(() => {
  parser.load.mockReset();
  parser.extract.mockReset();
  fetcher.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("PDF.js loading task lifecycle and timeouts (#85)", () => {
  it("does not start loading after the PDF.js module resolves past the deadline", async () => {
    vi.useFakeTimers();
    let fulfill: (value: unknown) => void = () => undefined;
    const withheld = new Promise<unknown>((resolve) => {
      fulfill = resolve;
    });
    const getDocument = vi.fn();
    parser.load.mockReturnValue(withheld);
    const pending = extractVerifiedTaskPdf(attachment, fetcher as typeof fetch, "555");
    // Attach the rejection observer before advancing fake time, so Vitest
    // never sees an unhandled rejection when the deadline fires.
    const outcome = pending.then(
      () => "unexpected_success",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(await outcome).toMatchObject({ code: "CLICKUP_PDF_TIMEOUT" });
    fulfill({ getDocument });
    await vi.advanceTimersByTimeAsync(0);
    expect(getDocument).not.toHaveBeenCalled();
    expect(parser.extract).not.toHaveBeenCalled();
  });

  it("cancels a pending PDF.js loading task once on timeout", async () => {
    vi.useFakeTimers();
    let fulfill: (value: unknown) => void = () => undefined;
    const waiting = new Promise<unknown>((resolve) => {
      fulfill = resolve;
    });
    const destroy = vi.fn(async () => undefined);
    const getDocument = vi.fn(() => ({ promise: waiting, destroy }));
    parser.load.mockResolvedValue({ getDocument });
    const pending = extractVerifiedTaskPdf(attachment, fetcher as typeof fetch, "555");
    // Attach the rejection observer before advancing fake time, so Vitest
    // never sees an unhandled rejection when the deadline fires.
    const outcome = pending.then(
      () => "unexpected_success",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(getDocument).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6_001);
    expect(await outcome).toMatchObject({ code: "CLICKUP_PDF_TIMEOUT" });
    expect(destroy).toHaveBeenCalledOnce();
    fulfill({ numPages: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(parser.extract).not.toHaveBeenCalled();
  });

  it("returns the timeout even when PDF.js destruction never settles", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn(() => new Promise<void>(() => undefined));
    const getDocument = vi.fn(() => ({
      promise: new Promise<unknown>(() => undefined),
      destroy,
    }));
    parser.load.mockResolvedValue({ getDocument });
    const pending = extractVerifiedTaskPdf(attachment, fetcher as typeof fetch, "555");
    const outcome = pending.then(
      () => "unexpected_success",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(getDocument).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6_001);
    expect(await outcome).toMatchObject({ code: "CLICKUP_PDF_TIMEOUT" });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("caps cleanup latency when successful parsing is followed by a stalled destroy", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn(() => new Promise<void>(() => undefined));
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 1 }),
      destroy,
    }));
    parser.load.mockResolvedValue({ getDocument });
    parser.extract.mockResolvedValue({ totalPages: 1, text: ["test"] });
    const pending = extractVerifiedTaskPdf(attachment, fetcher as typeof fetch, "555");
    let settled = false;
    const result = pending.then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(destroy).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(251);
    expect((await result)["pages"]).toMatchObject([{ text: "test" }]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("uses strict PDF parsing and destroys the loading task after success", async () => {
    const destroy = vi.fn(async () => undefined);
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 1 }),
      destroy,
    }));
    parser.load.mockResolvedValue({ getDocument });
    parser.extract.mockResolvedValue({ totalPages: 1, text: ["QA text only"] });
    const output = await extractVerifiedTaskPdf(attachment, fetcher as typeof fetch, "555");
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        stopAtErrors: true,
        isEvalSupported: false,
        maxImageSize: 4_194_304,
      }),
    );
    expect(output["pages"]).toEqual([{ page: 1, text: "QA text only", truncated: false }]);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
