# Product feedback

Devpost asks, for every tool/API/SDK used: what we used it for, what worked well, what needs work, how onboarding felt, and whether we'd build with it again. Draft; finalized before submission.

## Alexa+ MCP Toolkit (docs + `alexa-ai` CLI)

- **Used for**: Target integration surface. HomeKeeper is built to the documented contract (MCP 2025-11-25, Streamable HTTP, MCP Apps `resourceUri` for visuals, elicitation for confirmations).
- **Worked well**: The decision to adopt MCP as-is rather than a proprietary skill model. Everything we built is portable to Claude, ChatGPT, VS Code, and Alexa+ with zero code changes. The docs are clear on transport requirements and on when Alexa+ re-reads tool definitions (only on `alexa-ai deploy`).
- **Needs work**: Private Preview gating (see friction log #1). Identity contract for account-linked calls (#2). No published `addon.json` validator. No statement on whether Alexa+ supports MCP elicitation or only the two-step "return a quote, then confirm" pattern; we implemented both defensively.
- **Onboarding**: Docs-only onboarding was good; tooling onboarding was not possible without preview access.
- **Build again?**: Yes. MCP-native is the right bet.

## Model Context Protocol TypeScript SDK (`@modelcontextprotocol/sdk` 1.30)

- **Used for**: Server (tools, resources, prompts, elicitation) and client (simulator).
- **Worked well**: `McpServer.registerTool` with zod schemas, `StreamableHTTPServerTransport` in both stateful and stateless modes, `server.server.elicitInput()`.
- **Needs work**: The stateful session-management pattern (map of sessionId to transport) is left to the user and is easy to get wrong; a built-in session manager would help. The `RequestHandlerExtra` type for tool handlers is awkward to import.
- **Build again?**: Yes.

## MCP Apps SDK (`@modelcontextprotocol/ext-apps` 1.7)

- **Used for**: Interactive cards (appliance carousel, troubleshooting with source page, maintenance timeline, order confirmation).
- **Worked well**: `registerAppTool` / `registerAppResource` helpers; `App` class with `ontoolresult`, `callServerTool`, `sendMessage`; host style variables so cards match the host theme.
- **Needs work**: Host availability for testing (friction #5). Single-file HTML requirement means a custom build step per view.
- **Build again?**: Yes.

## Amazon Bedrock (Converse API, Titan Text Embeddings V2)

- **Used for**: Maintenance-schedule refinement per brand/model, grounded troubleshooting synthesis, embeddings for manual retrieval, and the reasoning loop in the simulated Alexa+ host.
- **Worked well**: Converse API is model-agnostic so swapping Claude variants is a config change. Titan v2 with `dimensions: 512` keeps chunk storage small.
- **Needs work**: Model access enablement is a console step that can't be done from the CLI/CDK. Cross-region inference profile IDs are hard to discover programmatically.
- **Onboarding**: Fine with an existing account; the model-access step surprises first-timers.
- **Build again?**: Yes.

## Amazon Nova 2 Sonic (Bedrock bidirectional streaming)

- **Used for**: The live voice channel of the simulated Alexa+ host: microphone in, transcription, reasoning, calling HomeKeeper's MCP tools, barge-in.
- **Worked well**: Tool use over the stream is solid and fast; the model called `troubleshoot` with the right appliance and error code from spoken input on the first try. `SPECULATIVE` text arrives before audio, which made swapping the voice possible. Endpointing sensitivity is a useful knob.
- **Needs work**: Voice quality versus Polly generative (friction #8). No way to turn off audio output or pick a Polly voice. The Node SDK path needs `NodeHttp2Handler` and the initial events queued before `send()`, neither of which is in the Bedrock Runtime API reference; we found it in the samples repo.
- **Onboarding**: Event schema docs are complete; the deadlock behaviour cost an hour.
- **Build again?**: Yes as the ears and brain; not yet as the mouth.

## Amazon Polly (generative engine)

- **Used for**: The voice the user hears (Joanna, the classic Alexa voice), for both typed turns and Sonic-driven live turns.
- **Worked well**: Generative Joanna is a clear step up from neural and from browser TTS; `say-as characters` handles error codes; PCM output slots straight into the Web Audio queue.
- **Needs work**: PCM is capped at 16 kHz while Sonic emits 24 kHz, so the two paths differ in fidelity. No streaming synthesis for long sentences.
- **Build again?**: Yes.

## Amazon Bedrock AgentCore Runtime (direct code deploy, Node.js 22)

- **Used for**: Hosting the MCP server.
- **Worked well**: Zip deploy with no Docker; MCP protocol mode expects exactly `0.0.0.0:8000/mcp`, which matches the SDK default; CloudFormation `AWS::BedrockAgentCore::Runtime` exists so CDK works.
- **Needs work**: Endpoint URL shape and auth (friction #3). Limited failure detail on `CREATE_FAILED`.
- **Build again?**: Yes for MCP servers that need session affinity; for a public unauthenticated endpoint a Lambda function URL is simpler.

## AWS CDK

- **Used for**: DynamoDB table, S3 bucket, IAM role, Cognito, AgentCore Runtime.
- **Worked well**: L1 `CfnRuntime` available on day one of needing it.
- **Needs work**: No L2 for AgentCore yet, so property names are strings.
- **Build again?**: Yes.

## Amazon DynamoDB + S3

- **Used for**: Household state (single-table design) and manual chunks with embeddings.
- **Worked well**: Predictable; `lib-dynamodb` document client removes marshalling boilerplate.
- **Needs work**: Nothing material at this scale.
- **Build again?**: Yes.
