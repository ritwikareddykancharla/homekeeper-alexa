import { App } from "aws-cdk-lib";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HomeKeeperStack } from "../lib/homekeeper-stack.js";
import { HomeKeeperDemoStack } from "../lib/homekeeper-demo-stack.js";

const app = new App();
const region = (app.node.tryGetContext("region") as string | undefined) ?? "us-east-1";
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

new HomeKeeperStack(app, "HomeKeeper", {
  env,
  description: "HomeKeeper: Alexa+ MCP server on Bedrock AgentCore Runtime with DynamoDB and S3 (Amazon Developer Hackathon 2026)",
  // "iam" (default): callers sign with SigV4. "jwt": Cognito-issued bearer tokens, for Alexa+ OAuth account linking.
  inboundAuth: (app.node.tryGetContext("auth") as "iam" | "jwt" | undefined) ?? "iam",
  bedrockModelId: app.node.tryGetContext("modelId") as string | undefined
});

// Public demo of the simulated Alexa+ host. Needs the runtime ARN from a previous
// HomeKeeper deploy: pass -c runtimeArn=... or let it read cdk-outputs.json.
const here = dirname(fileURLToPath(import.meta.url));
const outputsPath = resolve(here, "../cdk-outputs.json");
const runtimeArn =
  (app.node.tryGetContext("runtimeArn") as string | undefined) ??
  (existsSync(outputsPath) ? (JSON.parse(readFileSync(outputsPath, "utf8")) as { HomeKeeper?: { RuntimeArn?: string } }).HomeKeeper?.RuntimeArn : undefined);
if (runtimeArn) {
  new HomeKeeperDemoStack(app, "HomeKeeperDemo", {
    env,
    description: "HomeKeeper: public demo of the simulated Alexa+ host (EC2 + CloudFront)",
    runtimeArn,
    repoUrl: (app.node.tryGetContext("repoUrl") as string | undefined) ?? "https://github.com/ritwikareddykancharla/homekeeper-alexa.git",
    gitRef: app.node.tryGetContext("gitRef") as string | undefined
  });
}
