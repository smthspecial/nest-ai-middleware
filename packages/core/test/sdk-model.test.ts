import { describe, expect, it, jest } from "@jest/globals";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { SdkModel } from "../src/index.js";

function sdkV3(doGenerate: LanguageModelV3["doGenerate"]): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "scripted",
    supportedUrls: {},
    doGenerate,
    doStream() {
      throw new Error("Unexpected stream call");
    },
  };
}

describe("SdkModel", () => {
  it("adapts V3 file inputs with host instructions, settings, and cancellation", async () => {
    const generate = jest
      .fn<LanguageModelV3["doGenerate"]>()
      .mockResolvedValue({
        content: [{ type: "text", text: "Ready." }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 7,
            noCache: 7,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 2, text: 2, reasoning: undefined },
        },
        warnings: [],
      });
    const model = new SdkModel(sdkV3(generate), {
      instructions: "Write short answers.",
      toolCalling: false,
      maxOutputTokens: 64,
      providerOptions: { test: { verbosity: "low" } },
    });
    const abortSignal = AbortSignal.timeout(1000);
    const pdf = {
      mediaType: "application/pdf",
      data: Buffer.from("%PDF-1.7\n%%EOF"),
      filename: "report.pdf",
    };
    const request = {
      messages: [{ role: "user" as const, content: "Ready?" }],
      tools: [],
      attachments: [pdf],
      abortSignal,
    };

    await expect(model.generate(request)).resolves.toEqual({
      kind: "final",
      message: "Ready.",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(model.capabilities.toolCalling).toBe(false);
    expect(generate.mock.calls[0]?.[0]).toEqual({
      prompt: [
        { role: "system", content: "Write short answers." },
        {
          role: "user",
          content: [
            { type: "text", text: "Ready?" },
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "report.pdf",
              data: pdf.data,
            },
          ],
        },
      ],
      maxOutputTokens: 64,
      providerOptions: { test: { verbosity: "low" } },
      abortSignal,
    });

    await expect(
      model.generate({ ...request, abortSignal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("maps rate limits without exposing provider errors", async () => {
    const model = new SdkModel(
      sdkV3(async () => {
        throw new APICallError({
          message: "Provider details",
          url: "https://example.test",
          requestBodyValues: {},
          statusCode: 429,
        });
      }),
    );

    await expect(
      model.generate({ messages: [], tools: [] }),
    ).rejects.toMatchObject({
      code: "MODEL_RATE_LIMITED",
      message: "MODEL_RATE_LIMITED",
    });
  });
});
