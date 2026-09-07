import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type Message
} from "@aws-sdk/client-bedrock-runtime";

export interface AiProvider {
  readonly enabled: boolean;
  /** Free-form completion. Returns undefined if the provider is disabled or fails. */
  complete(system: string, user: string, opts?: { maxTokens?: number; json?: boolean }): Promise<string | undefined>;
  /** Embed a batch of texts. Returns undefined if unavailable. */
  embed(texts: string[]): Promise<number[][] | undefined>;
}

/**
 * Amazon Bedrock provider: Claude via the Converse API for reasoning and
 * Titan Text Embeddings V2 for retrieval. Disabled cleanly when
 * BEDROCK_DISABLED=1 or when no credentials/region are available, so the server
 * still runs (with rule-based fallbacks) on a laptop without AWS.
 */
export class BedrockProvider implements AiProvider {
  readonly enabled: boolean;
  private client: BedrockRuntimeClient;
  private modelId: string;
  private embedModelId: string;
  private failed = false;

  constructor(opts: { region?: string; modelId?: string; embedModelId?: string; enabled?: boolean } = {}) {
    const region = opts.region ?? process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    this.modelId = opts.modelId ?? process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    this.embedModelId = opts.embedModelId ?? process.env.BEDROCK_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0";
    this.enabled = opts.enabled ?? process.env.BEDROCK_DISABLED !== "1";
    this.client = new BedrockRuntimeClient({ region });
  }

  async complete(system: string, user: string, opts: { maxTokens?: number; json?: boolean } = {}) {
    if (!this.enabled || this.failed) return undefined;
    try {
      const messages: Message[] = [{ role: "user", content: [{ text: user }] }];
      if (opts.json) {
        // Prefill the assistant turn so Claude returns raw JSON.
        messages.push({ role: "assistant", content: [{ text: "{" }] });
      }
      const res = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: system }],
          messages,
          inferenceConfig: { maxTokens: opts.maxTokens ?? 1024, temperature: 0.2 }
        })
      );
      const text = res.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
      return opts.json ? `{${text}` : text;
    } catch (err) {
      this.noteFailure("converse", err);
      return undefined;
    }
  }

  async embed(texts: string[]) {
    if (!this.enabled || this.failed || texts.length === 0) return undefined;
    try {
      const out: number[][] = [];
      // Titan v2 embeds one text per call; keep it simple and parallel in small batches.
      for (let i = 0; i < texts.length; i += 8) {
        const batch = texts.slice(i, i + 8);
        const vecs = await Promise.all(
          batch.map(async (t) => {
            const res = await this.client.send(
              new InvokeModelCommand({
                modelId: this.embedModelId,
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({ inputText: t.slice(0, 8000), dimensions: 512, normalize: true })
              })
            );
            const json = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
            return json.embedding;
          })
        );
        out.push(...vecs);
      }
      return out;
    } catch (err) {
      this.noteFailure("embed", err);
      return undefined;
    }
  }

  private noteFailure(op: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bedrock] ${op} failed, falling back to rule-based mode: ${msg}`);
    // Credential / access errors are sticky for this process; transient errors are not.
    if (/credential|AccessDenied|not authorized|UnrecognizedClient|ExpiredToken|Could not load/i.test(msg)) {
      this.failed = true;
    }
  }
}

export class DisabledProvider implements AiProvider {
  readonly enabled = false;
  async complete() {
    return undefined;
  }
  async embed() {
    return undefined;
  }
}

export function createAiFromEnv(): AiProvider {
  if (process.env.BEDROCK_DISABLED === "1") return new DisabledProvider();
  return new BedrockProvider();
}
