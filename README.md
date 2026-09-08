# HomeKeeper

**Your home's memory, on Alexa+.**

HomeKeeper is an [Alexa+](https://developer.amazon.com/alexaplus/) add-on built as a self-hosted [MCP](https://modelcontextprotocol.io) server. It remembers every appliance in your house, reads their manuals so you don't have to, keeps a maintenance schedule it builds itself, and reorders the parts you forget about.

> "Alexa, the dishwasher is showing E24."
> "That's a drain error on your Bosch 300 Series. Check the drain hose for a kink and clean the filter under the lower rack. Want me to show you the steps?"

Built for the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com) (Alexa+ track, AWS Builder and Open Source mini challenges).

## Why

Every household owns 20 to 40 appliances and devices, each with a manual nobody keeps, a warranty nobody tracks, and a filter nobody remembers to replace. The information exists; it's just scattered across PDFs, receipts, and the back of a cabinet. A voice assistant that lives in the kitchen is the natural place for it, but only if it can actually *remember* across sessions and *read* the source material instead of guessing.

HomeKeeper does both:

- **Remembers.** Appliances, purchase dates, warranties, and maintenance history persist per household across every conversation.
- **Reads.** Manuals are chunked, embedded with Amazon Bedrock, and retrieved per question, so troubleshooting answers are grounded in the actual document, with the source excerpt shown as a card.
- **Plans.** When you register an appliance, HomeKeeper derives its maintenance schedule (filters, descaling, inspections) and surfaces what's due.
- **Acts.** Consumables are linked to products, so "order the fridge filter" is one turn.



## How it works

```
Alexa+ (MCP client)  --Streamable HTTP-->  HomeKeeper MCP server        -->  Bedrock (Claude: reasoning; Titan: embeddings)
        |                                  on Bedrock AgentCore Runtime      DynamoDB (household state)
        |                                        |                           S3 (manual chunks + embeddings)
        +-- renders MCP App cards <--------------+
```

- **MCP server**: TypeScript, `@modelcontextprotocol/sdk`, MCP spec **2025-11-25**, **Streamable HTTP** transport. Runs stateful (sessions, needed for elicitation) or stateless; honours platform-injected session ids so it runs unchanged on Bedrock AgentCore Runtime.
- **MCP Apps**: tools declare `_meta.ui.resourceUri` so Alexa+ (and any MCP Apps host) renders rich cards: appliance carousel, troubleshooting with the manual excerpt, maintenance timeline, order confirmation. Views are single-file HTML served as `ui://homekeeper/*.html` resources.
- **Grounded troubleshooting**: manuals are chunked by section, embedded (Titan Text Embeddings V2), and retrieved with a hybrid of cosine similarity and keyword scoring, so exact error codes like `E24` always hit. Claude synthesises the answer from the retrieved chunks only. Without Bedrock the same pipeline falls back to keyword retrieval and rule-based answers.
- **Elicitation**: order confirmation goes through MCP elicitation when the host supports it; otherwise the tool returns a quote and expects a second call with `confirm=true`. Ambiguous appliance references return candidates instead of guessing.
- **Simulated Alexa+ host** (`packages/simulator`): a web app that speaks to the same server exactly as Alexa+ would: Bedrock Converse tool loop, MCP client (SigV4-signed for AgentCore), MCP Apps rendering via `AppBridge` in sandboxed iframes, browser speech recognition in, Amazon Polly generative voice out. Falls back to a rule-based intent router if Bedrock is unreachable. This is the demo surface while the Alexa+ MCP Toolkit is in Private Preview.



### Tools exposed


| Tool                 | What it does                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `register_appliance` | Add an appliance (brand, model, room, purchase date). Auto-derives maintenance schedule.   |
| `list_appliances`    | Household inventory, rendered as a carousel card.                                          |
| `ingest_manual`      | Attach a manual (URL or upload) and index it for retrieval.                                |
| `troubleshoot`       | Grounded Q&A against the appliance's manual (error codes, how-tos), with source page card. |
| `maintenance_due`    | What needs attention now and in the next 30 days.                                          |
| `log_maintenance`    | Record a completed task, resets its schedule.                                              |
| `reorder_consumable` | Find and order the matching filter / part / consumable.                                    |
| `warranty_status`    | Is it still covered, and what do I need to claim.                                          |
| `maintenance_history`| What has been done, when.                                                                  |
| `remove_appliance`   | Forget an appliance.                                                                       |

Plus a `weekly_checkup` prompt and four `ui://homekeeper/*.html` MCP App resources.




## Repository layout

```
.
├── packages/
│   ├── server/        # HomeKeeper MCP server (TypeScript, Streamable HTTP)
│   │   └── src/knowledge/manuals/   # bundled sample manuals (Bosch, Samsung, Keurig, LG)
│   ├── ui/            # MCP App views (single-file HTML cards rendered by the host)
│   └── simulator/     # Simulated Alexa+ host: Node API (Bedrock + MCP client) and Vite web UI
├── infra/             # AWS CDK: DynamoDB, S3, IAM, Bedrock AgentCore Runtime, optional Cognito
├── docs/
│   ├── friction-log.md
│   └── product-feedback.md
├── LICENSE            # MIT
└── README.md
```



## Running locally

Prerequisites: Node.js 22+. AWS credentials with Bedrock access are optional locally; without them the server and simulator run in rule-based mode (keyword retrieval, no LLM), which is enough to see every tool and card work.

```bash
npm install
npm run dev            # MCP server on http://localhost:3000/mcp, simulator UI on http://localhost:5173
```

With Bedrock (set `AWS_PROFILE`/`AWS_REGION`; enable Claude Sonnet 4.5 and Titan Text Embeddings V2 in the Bedrock console):

```bash
AWS_PROFILE=hackathon AWS_REGION=us-east-1 npm run dev
```

Useful environment variables (all optional):

| Variable | Where | Meaning |
| --- | --- | --- |
| `PORT` | server | Listen port (default 3000; AgentCore uses 8000) |
| `MCP_STATELESS=1` | server | One transport per request instead of sessions |
| `BEDROCK_DISABLED=1` | server | Force rule-based mode |
| `BEDROCK_MODEL_ID`, `BEDROCK_EMBED_MODEL_ID` | server, simulator | Model overrides |
| `TABLE_NAME`, `MANUALS_BUCKET` | server | Use DynamoDB + S3 instead of the in-memory store |
| `DATA_FILE` | server | JSON file for the in-memory store (`none` to disable) |
| `SEED_DEMO=1` | server | Seed the demo household on first start |
| `MCP_URL` | simulator | MCP endpoint (local or AgentCore invocation URL) |
| `MCP_AUTH` | simulator | `none`, `sigv4` (auto for AgentCore URLs) or `bearer` |
| `HOST_MODE=rules` | simulator | Skip Bedrock and use the intent router |
| `POLLY_VOICE`, `POLLY_ENGINE` | simulator | Spoken replies: Polly voice (default `Danielle`) and engine (default `generative`) |

Inspect the server with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

## Deploying to AWS

Infrastructure is defined in `infra/` with the AWS CDK. The MCP server is deployed to **Amazon Bedrock AgentCore Runtime** as a Node.js 22 direct-code zip (no container build).

```bash
export AWS_PROFILE=hackathon AWS_REGION=us-east-1
npx cdk bootstrap -a "npx tsx infra/bin/app.ts"     # once per account/region
npm run deploy                                      # builds UI + server bundle, then cdk deploy
```

Outputs include the runtime ARN; the MCP endpoint is

```
https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<url-encoded RuntimeArn>/invocations?qualifier=DEFAULT
```

By default inbound auth is IAM (SigV4). For an OAuth-protected endpoint (what Alexa+ account linking expects), deploy with `-c auth=jwt` to add a Cognito user pool whose client-credentials tokens the runtime accepts:

```bash
npm run deploy -w @homekeeper/infra -- -c auth=jwt
```

Point the simulator at the hosted server:

```bash
MCP_URL="https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<encoded-arn>/invocations?qualifier=DEFAULT" npm run dev -w @homekeeper/simulator
```

## Connecting to Alexa+

Once you have Alexa+ MCP Toolkit access, point the Alexa AI CLI at the deployed server:

```bash
alexa-ai new mcp --name "HomeKeeper" --locale en-US --mcp-server-url "https://<your-endpoint>/mcp"
alexa-ai deploy
```

Alexa+ introspects the tools, registers the add-on, and you can test in the web simulator or on a device.

## AWS services used


| Service                          | Role                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Amazon Bedrock (Claude Sonnet 4.5, Converse API) | Tool-side reasoning: maintenance schedule refinement, grounded troubleshooting synthesis; host-side reasoning in the simulator |
| Amazon Bedrock (Titan Text Embeddings V2) | Manual chunk embeddings for retrieval                                                                        |
| Amazon Bedrock AgentCore Runtime | Hosting the MCP server (MCP protocol mode, Node.js 22 direct code deploy, session affinity)                          |
| Amazon Polly (generative voices) | Spoken replies in the simulated Alexa+ host, with SSML so error codes are read letter by letter                        |
| Amazon DynamoDB                  | Per-household appliances, schedules, maintenance history, orders (single-table)                                       |
| Amazon S3                        | Manual chunks with embeddings                                                                                         |
| Amazon Cognito (optional)        | JWT issuer for OAuth-protected inbound auth                                                                           |
| AWS CDK                          | Infrastructure as code                                                                                                |




## Status and roadmap

Active development for the hackathon (deadline Oct 23, 2026).

- [x] MCP server: 10 tools, Streamable HTTP (stateful + stateless), MCP spec 2025-11-25
- [x] Household state: appliances, derived maintenance schedules, logs, orders (in-memory + DynamoDB/S3 stores)
- [x] Grounded troubleshooting: manual chunking, hybrid retrieval (Bedrock embeddings + keyword), bundled sample manuals
- [x] Order confirmation via MCP elicitation, with two-step fallback for hosts without it
- [x] MCP App views: appliance carousel, troubleshoot card, maintenance timeline, order card
- [x] Simulated Alexa+ host (web app): Bedrock-backed reasoning with rules fallback, MCP client, MCP Apps rendering, voice in/out
- [x] AWS CDK: DynamoDB, S3, IAM, Bedrock AgentCore Runtime (Node.js 22 direct code deploy), optional Cognito
- [x] Local end-to-end: utterance to tool call to grounded answer to rendered card, including elicitation round-trip
- [ ] Deploy to AWS and test against the hosted server (waiting on account credentials)
- [ ] Alexa+ MCP Toolkit registration (`alexa-ai new mcp` / `alexa-ai deploy`) once Private Preview access is granted
- [ ] Demo video; finalize [friction log](docs/friction-log.md) and [product feedback](docs/product-feedback.md)

## License

[MIT](./LICENSE)