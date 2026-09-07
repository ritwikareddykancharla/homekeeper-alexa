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
- **Reads.** Manuals are ingested into a Bedrock Knowledge Base, so troubleshooting answers are grounded in the actual document, with the relevant page shown as a card.
- **Plans.** When you register an appliance, HomeKeeper derives its maintenance schedule (filters, descaling, inspections) and surfaces what's due.
- **Acts.** Consumables are linked to products, so "order the fridge filter" is one turn.



## How it works

```
Alexa+ (MCP client)  --Streamable HTTP-->  HomeKeeper MCP server  -->  Bedrock (RAG, reasoning)
        |                                        |                        DynamoDB (household state)
        |                                        |                        S3 + Bedrock Knowledge Base (manuals)
        +-- renders MCP App cards <--------------+
```

- **MCP server**: TypeScript, `@modelcontextprotocol/sdk`, MCP spec **2025-11-25**, **Streamable HTTP** transport, stateless-compatible so it runs behind load balancers and on Bedrock AgentCore Runtime.
- **MCP Apps**: tool results carry `_meta.ui.resourceUri` so Alexa+ (and any MCP Apps host) renders rich cards: appliance carousel, manual page viewer, maintenance timeline, reorder confirmation.
- **Elicitation**: when a request is ambiguous ("the filter" in a house with three filters), the server asks instead of guessing.
- **Simulated Alexa+ host**: a web app that speaks to the same server exactly as Alexa+ would (Bedrock-backed reasoning, MCP client, MCP Apps rendering). This is the demo surface while the Alexa+ MCP Toolkit is in Private Preview.



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




## Repository layout

```
.
├── packages/
│   ├── server/        # HomeKeeper MCP server (TypeScript, Streamable HTTP)
│   ├── ui/            # MCP App views (cards rendered by the host)
│   └── simulator/     # Simulated Alexa+ host web app
├── infra/             # AWS CDK: DynamoDB, S3, Bedrock Knowledge Base, AgentCore Runtime
├── docs/
│   ├── friction-log.md
│   └── product-feedback.md
├── LICENSE            # MIT
└── README.md
```



## Running locally

Prerequisites: Node.js 22+, an AWS profile with Bedrock access (us-east-1).

```bash
npm install
npm run dev            # starts the MCP server on http://localhost:3000/mcp and the simulator on http://localhost:5173
```

Inspect the server with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

Detailed setup, deployment, and Alexa+ add-on registration instructions will land in `docs/` as the project takes shape.

## Deploying to AWS

Infrastructure is defined in `infra/` with the AWS CDK.

```bash
cd infra
npx cdk bootstrap --profile <your-profile>
npx cdk deploy --profile <your-profile>
```

This provisions DynamoDB (household state), S3 + Bedrock Knowledge Base (manuals), and hosts the MCP server on Bedrock AgentCore Runtime behind HTTPS.

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
| Amazon Bedrock (Claude)          | Tool-side reasoning: maintenance schedule derivation, troubleshooting synthesis; host-side reasoning in the simulator |
| Amazon Bedrock Knowledge Bases   | Manual ingestion, chunking, embedding, and retrieval                                                                  |
| Amazon Bedrock AgentCore Runtime | Hosting the MCP server (Streamable HTTP, session-aware)                                                               |
| Amazon DynamoDB                  | Per-household appliances, schedules, maintenance history                                                              |
| Amazon S3                        | Manual storage                                                                                                        |
| AWS CDK                          | Infrastructure as code                                                                                                |




## Status and roadmap

Active development for the hackathon (deadline Oct 23, 2026).

- [x] MCP server: 10 tools, Streamable HTTP (stateful + stateless), MCP spec 2025-11-25
- [x] Household state: appliances, derived maintenance schedules, logs, orders (in-memory + DynamoDB/S3 stores)
- [x] Grounded troubleshooting: manual chunking, hybrid retrieval (Bedrock embeddings + keyword), bundled sample manuals
- [x] Order confirmation via MCP elicitation, with two-step fallback for hosts without it
- [ ] MCP App views: appliance carousel, troubleshoot card, maintenance timeline, order card
- [ ] Simulated Alexa+ host (web app): Bedrock-backed reasoning, MCP client, MCP Apps rendering, voice in/out
- [ ] AWS CDK: DynamoDB, S3, Bedrock AgentCore Runtime (Node.js 22 direct code deploy)
- [ ] Deploy, end-to-end test against the hosted server
- [ ] Alexa+ MCP Toolkit registration (`alexa-ai new mcp` / `alexa-ai deploy`) once Private Preview access is granted
- [ ] Demo video, friction log, product feedback (`docs/`)

## License

[MIT](./LICENSE)