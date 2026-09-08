/**
 * Simulator configuration, all from environment variables.
 *
 *   MCP_URL        MCP endpoint. Local server: http://localhost:3000/mcp
 *                  AgentCore: https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<url-encoded arn>/invocations?qualifier=DEFAULT
 *   MCP_AUTH       none | sigv4 | bearer   (auto: sigv4 when MCP_URL is an AgentCore URL)
 *   MCP_BEARER_TOKEN  token for MCP_AUTH=bearer
 *   AWS_REGION     region for Bedrock + SigV4 (default us-east-1)
 *   BEDROCK_MODEL_ID  Converse model (default Claude Sonnet 4.5 cross-region profile)
 *   HOUSEHOLD_ID   sent as x-household-id (default demo-home)
 *   PORT           simulator API port (default 3001)
 */
const mcpUrl = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const isAgentCore = /bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com/.test(mcpUrl);

export const config = {
  mcpUrl,
  mcpAuth: (process.env.MCP_AUTH as "none" | "sigv4" | "bearer" | undefined) ?? (isAgentCore ? "sigv4" : "none"),
  bearerToken: process.env.MCP_BEARER_TOKEN,
  region: process.env.AWS_REGION ?? "us-east-1",
  modelId: process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  householdId: process.env.HOUSEHOLD_ID ?? "demo-home",
  port: Number(process.env.PORT ?? 3001),
  /** bedrock (default) or rules. Bedrock auto-falls back to rules on access errors. */
  hostMode: (process.env.HOST_MODE as "bedrock" | "rules" | undefined) ?? "bedrock",
  isAgentCore
};
