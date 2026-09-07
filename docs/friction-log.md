# Friction log

Format per Devpost: task attempted, steps taken, expected vs actual, severity, workaround, actionable suggestion. Entries are in the order we hit them.

---

## 1. Alexa+ MCP Toolkit is Private Preview

- **Task**: Register the HomeKeeper MCP server as an Alexa+ add-on and test it in the Alexa+ web simulator.
- **Steps**: Read the [MCP Toolkit Overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html) and [QuickStart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html); tried to find the `alexa-ai` CLI download.
- **Expected**: Install the CLI, run `alexa-ai new mcp --mcp-server-url ...`, deploy to the development stage, test.
- **Actual**: The Development Stages page says you must "request access to the Private Preview" and receive credentials before the CLI is available. No self-serve path.
- **Severity**: High (blocks the primary track's intended path).
- **Workaround**: Built a simulated Alexa+ host (`packages/simulator`) that connects to the same MCP server over Streamable HTTP, uses Bedrock for reasoning, and renders MCP App cards. The hackathon rules explicitly allow this path.
- **Suggestion**: A hackathon-scoped preview tier (even with a tool-count cap and no certification) would let participants demo on the real simulator. At minimum, publish the `alexa-ai` CLI's `addon.json` validator so we can lint the manifest offline.

## 2. Household identity for account-linked MCP calls is under-specified

- **Task**: Scope stored data (appliances, schedules) to the Alexa+ customer making the request.
- **Steps**: Read [MCP Client and App Lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html) for how the customer identity reaches the server.
- **Expected**: A documented header, `_meta` key, or OAuth claim that identifies the customer/household per tool call.
- **Actual**: The docs say "if the customer is account-linked, your MCP server can provide more personalized results" but not what the server receives or where.
- **Severity**: Medium.
- **Workaround**: `householdIdFrom()` in `packages/server/src/mcp.ts` accepts an `x-household-id` header (simulator), then falls back to the OAuth `sub` from the bearer token, then a default.
- **Suggestion**: Document the exact identity contract (header name or JWT claims) with an example request.

## 3. AgentCore Runtime endpoint is not a plain public HTTPS URL

- **Task**: Host the MCP server somewhere Alexa+ can reach.
- **Steps**: Deployed to Bedrock AgentCore Runtime (direct code deploy, Node.js 22). Looked up the invocation URL format.
- **Expected**: A URL I can paste into `addon.json` `integrations[].config.endpoints.default.uri`.
- **Actual**: The URL is `https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<url-encoded-arn>/invocations?qualifier=DEFAULT` and requires either SigV4 (IAM) or a JWT from a configured authorizer. Alexa+ supports OAuth-protected endpoints, so this is workable, but the two auth models need to be lined up (Cognito as the JWT issuer for both).
- **Severity**: Medium.
- **Workaround**: CDK stack provisions a Cognito user pool + app client and configures the runtime's `customJwtAuthorizer` with its discovery URL; the simulator obtains a client-credentials token.
- **Suggestion (AWS)**: An option on AgentCore Runtime to emit a friendly custom-domain HTTPS endpoint for MCP servers. **Suggestion (Alexa+)**: Publish an AgentCore-hosted MCP add-on example in the docs since both products are Amazon.

## 4. Node.js 22 target vs. local Node 26

- **Task**: Build the deployment bundle.
- **Steps**: `esbuild --target=node22`, checked `engines.node` constraints per the [Node.js direct deploy guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-node.html).
- **Expected**: Bundle runs identically locally and on the runtime.
- **Actual**: Fine so far, but the guide warns that any dependency declaring `engines.node` that excludes 22 fails creation with `CREATE_FAILED` and no per-package detail.
- **Severity**: Low.
- **Workaround**: Bundle everything into one file (no `node_modules` in the zip) so the check has nothing to trip on.
- **Suggestion**: Report the offending package name in the failure reason.

## 5. MCP Apps host support outside Claude/ChatGPT/VS Code is thin

- **Task**: Preview the MCP App cards before wiring them into Alexa+.
- **Steps**: Looked for a lightweight host. `@modelcontextprotocol/ext-apps` ships `examples/basic-host` only.
- **Expected**: `npx` a host, point it at `http://localhost:3000/mcp`, see cards.
- **Actual**: Had to build host-side rendering into the simulator (`AppBridge` + sandboxed iframe) ourselves. MCP Inspector shows the `_meta.ui.resourceUri` but does not render it.
- **Severity**: Low.
- **Workaround**: Simulator doubles as an MCP Apps host.
- **Suggestion**: Ship `basic-host` as an npm binary.

<!-- Add entries below as they happen. -->
