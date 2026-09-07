import { App } from "aws-cdk-lib";
import { HomeKeeperStack } from "../lib/homekeeper-stack.js";

const app = new App();

new HomeKeeperStack(app, "HomeKeeper", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // AgentCore Runtime is regional; us-east-1 has every model we use. Override with -c region=...
    region: (app.node.tryGetContext("region") as string | undefined) ?? "us-east-1"
  },
  description: "HomeKeeper: Alexa+ MCP server on Bedrock AgentCore Runtime with DynamoDB and S3 (Amazon Developer Hackathon 2026)",
  // "iam" (default): callers sign with SigV4. "jwt": Cognito-issued bearer tokens, for Alexa+ OAuth account linking.
  inboundAuth: (app.node.tryGetContext("auth") as "iam" | "jwt" | undefined) ?? "iam",
  bedrockModelId: app.node.tryGetContext("modelId") as string | undefined
});
