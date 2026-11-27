import { parsePatternList } from "./filter.js";
import type { Severity } from "./findings.js";
import { SEVERITIES } from "./findings.js";
import type { Effort } from "./reviewer.js";

export interface Inputs {
  anthropicApiKey: string;
  githubToken: string;
  model: string;
  include: string[];
  exclude: string[];
  skipGenerated: boolean;
  maxComments: number;
  severityThreshold: Severity;
  failOn: Severity | "none";
  maxTokensPerChunk: number;
  maxChunks: number;
  maxOutputTokens: number;
  effort: Effort | null;
  refusalFallback: boolean;
  reviewInstructions: string;
  skipDrafts: boolean;
  dryRun: boolean;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export class InputError extends Error {
  override readonly name = "InputError";
}

type Getter = (name: string) => string;

/** Read and validate action inputs. `get` mirrors core.getInput (trimmed, "" when unset). */
export function readInputs(get: Getter): Inputs {
  return {
    anthropicApiKey: get("anthropic_api_key"),
    githubToken: get("github_token"),
    model: get("model") || DEFAULT_MODEL,
    include: parsePatternList(get("include")),
    exclude: parsePatternList(get("exclude")),
    skipGenerated: bool(get, "skip_generated", true),
    maxComments: int(get, "max_comments", 20, 0, 100),
    severityThreshold: oneOf(get, "severity_threshold", SEVERITIES, "medium"),
    failOn: oneOf(get, "fail_on", [...SEVERITIES, "none"] as const, "none"),
    maxTokensPerChunk: int(get, "max_tokens_per_chunk", 30_000, 1_000, 500_000),
    maxChunks: int(get, "max_chunks", 10, 1, 100),
    maxOutputTokens: int(get, "max_output_tokens", 16_000, 1_024, 64_000),
    effort: get("effort") === "" ? null : oneOf(get, "effort", EFFORTS, "medium"),
    refusalFallback: bool(get, "refusal_fallback", true),
    reviewInstructions: get("review_instructions"),
    skipDrafts: bool(get, "skip_drafts", true),
    dryRun: bool(get, "dry_run", false),
  };
}

function bool(get: Getter, name: string, fallback: boolean): boolean {
  const raw = get(name).toLowerCase();
  if (raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new InputError(`Input "${name}" must be "true" or "false", got "${raw}".`);
}

function int(get: Getter, name: string, fallback: number, min: number, max: number): number {
  const raw = get(name);
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new InputError(`Input "${name}" must be a whole number, got "${raw}".`);
  const value = Number(raw);
  if (value < min || value > max) throw new InputError(`Input "${name}" must be between ${min} and ${max}, got ${value}.`);
  return value;
}

function oneOf<T extends string>(get: Getter, name: string, allowed: readonly T[], fallback: T): T {
  const raw = get(name).toLowerCase();
  if (raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new InputError(`Input "${name}" must be one of ${allowed.join(", ")}; got "${raw}".`);
}
