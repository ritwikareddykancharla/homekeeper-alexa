import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { CfnRuntime } from "aws-cdk-lib/aws-bedrockagentcore";
import type { Construct } from "constructs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface HomeKeeperStackProps extends StackProps {
  inboundAuth: "iam" | "jwt";
  bedrockModelId?: string;
}

/**
 * HomeKeeper infrastructure.
 *
 *  - DynamoDB single table for household state
 *  - S3 bucket for manual chunks (with embeddings)
 *  - Bedrock AgentCore Runtime hosting the MCP server via Node.js 22 direct
 *    code deploy (zip in S3, no container build)
 *  - Optional Cognito user pool for JWT inbound auth (Alexa+ account linking)
 */
export class HomeKeeperStack extends Stack {
  constructor(scope: Construct, id: string, props: HomeKeeperStackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------ data
    const table = new dynamodb.Table(this, "Household", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY // hackathon project; flip to RETAIN for real households
    });

    const manuals = new s3.Bucket(this, "Manuals", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // ----------------------------------------------------------- server code
    const here = dirname(fileURLToPath(import.meta.url));
    const zipPath = resolve(here, "../../packages/server/homekeeper-server.zip");
    if (!existsSync(zipPath)) {
      throw new Error(`Server bundle not found at ${zipPath}. Run "npm run bundle -w @homekeeper/server" first.`);
    }
    const code = new Asset(this, "ServerCode", { path: zipPath });

    // ---------------------------------------------------------------- role
    const role = new iam.Role(this, "RuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` }
        }
      }),
      description: "Execution role for the HomeKeeper MCP server on AgentCore Runtime"
    });
    table.grantReadWriteData(role);
    manuals.grantReadWrite(role);
    code.grantRead(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockModels",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          `arn:aws:bedrock:*:${this.account}:application-inference-profile/*`
        ]
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Observability",
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
          "cloudwatch:PutMetricData"
        ],
        resources: ["*"]
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WorkloadIdentity",
        actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId"],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`
        ]
      })
    );

    // ------------------------------------------------------------ inbound auth
    let authorizerConfiguration: CfnRuntime.AuthorizerConfigurationProperty | undefined;
    if (props.inboundAuth === "jwt") {
      const pool = new cognito.UserPool(this, "Callers", {
        selfSignUpEnabled: false,
        removalPolicy: RemovalPolicy.DESTROY
      });
      const domain = pool.addDomain("Domain", { cognitoDomain: { domainPrefix: `homekeeper-${this.account}` } });
      const scope = new cognito.ResourceServerScope({ scopeName: "invoke", scopeDescription: "Invoke HomeKeeper MCP tools" });
      const resourceServer = pool.addResourceServer("Api", { identifier: "homekeeper", scopes: [scope] });
      const client = pool.addClient("Alexa", {
        generateSecret: true,
        oAuth: {
          flows: { clientCredentials: true },
          scopes: [cognito.OAuthScope.resourceServer(resourceServer, scope)]
        },
        accessTokenValidity: Duration.hours(1)
      });
      authorizerConfiguration = {
        customJwtAuthorizer: {
          discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}/.well-known/openid-configuration`,
          allowedClients: [client.userPoolClientId]
        }
      };
      new CfnOutput(this, "CognitoTokenUrl", { value: `${domain.baseUrl()}/oauth2/token` });
      new CfnOutput(this, "CognitoClientId", { value: client.userPoolClientId });
      new CfnOutput(this, "CognitoUserPoolId", { value: pool.userPoolId });
    }

    // --------------------------------------------------------------- runtime
    const runtime = new CfnRuntime(this, "Runtime", {
      agentRuntimeName: "homekeeper_mcp",
      description: "HomeKeeper MCP server (Alexa+ add-on backend)",
      roleArn: role.roleArn,
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } },
          runtime: "NODE_22",
          entryPoint: ["index.js"]
        }
      },
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "MCP",
      authorizerConfiguration,
      environmentVariables: {
        PORT: "8000",
        // AgentCore assigns Mcp-Session-Id per request and isolates clients by
        // runtime session instead, so the MCP layer must be stateless here.
        MCP_STATELESS: "1",
        TABLE_NAME: table.tableName,
        MANUALS_BUCKET: manuals.bucketName,
        BEDROCK_MODEL_ID: props.bedrockModelId ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        BEDROCK_EMBED_MODEL_ID: "amazon.titan-embed-text-v2:0",
        SEED_DEMO: "1",
        HOUSEHOLD_ID: "demo-home",
        DATA_FILE: "none"
      }
    });
    runtime.node.addDependency(role);

    // --------------------------------------------------------------- outputs
    new CfnOutput(this, "RuntimeArn", { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, "RuntimeId", { value: runtime.attrAgentRuntimeId });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "ManualsBucket", { value: manuals.bucketName });
    new CfnOutput(this, "InboundAuth", { value: props.inboundAuth });
    new CfnOutput(this, "McpUrlHint", {
      description: "MCP endpoint (URL-encode the ARN): https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<arn>/invocations?qualifier=DEFAULT",
      value: `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/{url-encoded RuntimeArn}/invocations?qualifier=DEFAULT`
    });
  }
}
