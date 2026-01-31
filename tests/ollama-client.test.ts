import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isOllamaRunning, listModels, hasModel } from "../src/ollama-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("Ollama Client", () => {
  describe("isOllamaRunning", () => {
    it("should return true when Ollama responds with 200", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true }),
      );

      expect(await isOllamaRunning()).toBe(true);
    });

    it("should return false when Ollama is unreachable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      expect(await isOllamaRunning()).toBe(false);
    });

    it("should return false on timeout", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
      );

      expect(await isOllamaRunning()).toBe(false);
    });

    it("should use OLLAMA_URL env var when set", async () => {
      vi.stubEnv("OLLAMA_URL", "http://remote:9999");
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      await isOllamaRunning();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://remote:9999",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  describe("listModels", () => {
    it("should parse model names from Ollama response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            models: [
              { name: "qwen3:8b" },
              { name: "qwen3-coder:30b" },
            ],
          }),
        }),
      );

      const models = await listModels();

      expect(models).toEqual(["qwen3:8b", "qwen3-coder:30b"]);
    });

    it("should return an empty array on error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      expect(await listModels()).toEqual([]);
    });

    it("should return an empty array when response has no models", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}),
        }),
      );

      expect(await listModels()).toEqual([]);
    });
  });

  describe("hasModel", () => {
    it("should return true when model exists (200)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true }),
      );

      expect(await hasModel("qwen3:8b")).toBe(true);
    });

    it("should return false when model is not found (404)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      );

      expect(await hasModel("nonexistent:latest")).toBe(false);
    });

    it("should return false on error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      expect(await hasModel("qwen3:8b")).toBe(false);
    });

    it("should POST to /api/show with the model name", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      await hasModel("qwen3:8b");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/show",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "qwen3:8b" }),
        }),
      );
    });
  });
});
