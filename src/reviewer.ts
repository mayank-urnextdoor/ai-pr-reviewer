import Anthropic from "@anthropic-ai/sdk";
import type { ParsedReview } from "./findings.js";
import { REVIEW_JSON_SCHEMA, parseReviewJson } from "./findings.js";
import type { PromptContext } from "./prompt.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ReviewerOptions {
  model: string;
  maxOutputTokens: number;
  /** Omit to use the model's default effort. */
  effort: Effort | null;
  /**
   * Ask the API to re-run a request that the model declines on a fallback
   * model (server-side fallbacks, beta). Disabled automatically for the rest
   * of the run if the model rejects the parameter.
   */
  refusalFallback: boolean;
  instructions: string;
  log?: (message: string) => void;
}

export interface ChunkReview extends ParsedReview {
  inputTokens: number;
  outputTokens: number;
  /** Model that actually produced the answer (differs if a fallback ran). */
  servedBy: string;
}

export class ReviewError extends Error {
  override readonly name = "ReviewError";
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Minimal surface of the SDK client we use, so tests can pass a stub. */
export type MessagesClient = Pick<Anthropic, "beta">;

export function createClient(apiKey: string): Anthropic {
  // The SDK retries 408/409/429/5xx and connection errors with backoff.
  return new Anthropic({ apiKey, maxRetries: 4 });
}

export class ClaudeReviewer {
  private fallbackEnabled: boolean;
  private readonly system: string;

  constructor(
    private readonly client: MessagesClient,
    private readonly options: ReviewerOptions,
  ) {
    this.fallbackEnabled = options.refusalFallback;
    this.system = buildSystemPrompt(options.instructions);
  }

  async review(ctx: PromptContext): Promise<ChunkReview> {
    const userPrompt = buildUserPrompt(ctx);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.send(userPrompt, this.fallbackEnabled);
    } catch (err) {
      // Not every model supports server-side fallbacks. If the request was
      // rejected as invalid, retry once without them and stop sending them.
      if (this.fallbackEnabled && err instanceof Anthropic.BadRequestError) {
        this.fallbackEnabled = false;
        this.options.log?.(`Request with refusal fallback was rejected (${err.message}); retrying without it.`);
        response = await this.send(userPrompt, false);
      } else {
        throw err;
      }
    }
    return this.interpret(response);
  }

  private send(userPrompt: string, withFallback: boolean): Promise<Anthropic.Beta.BetaMessage> {
    const { model, maxOutputTokens, effort } = this.options;
    return this.client.beta.messages.create({
      model,
      max_tokens: maxOutputTokens,
      system: this.system,
      messages: [{ role: "user", content: userPrompt }],
      output_config: {
        format: { type: "json_schema", schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown> },
        ...(effort ? { effort } : {}),
      },
      ...(withFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    });
  }

  private interpret(response: Anthropic.Beta.BetaMessage): ChunkReview {
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      throw new ReviewError(`the model declined to review this part of the diff (category: ${category})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ReviewError(
        "the response hit max_output_tokens before the JSON was complete; raise max_output_tokens or lower max_tokens_per_chunk",
      );
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.trim() === "") throw new ReviewError(`the response contained no text (stop_reason: ${response.stop_reason})`);

    let parsed: ParsedReview;
    try {
      parsed = parseReviewJson(text);
    } catch (err) {
      throw new ReviewError((err as Error).message, { cause: err });
    }
    const usage = response.usage;
    return {
      ...parsed,
      inputTokens:
        usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      servedBy: response.model,
    };
  }
}
