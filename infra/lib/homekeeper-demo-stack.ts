import { CfnOutput, Duration, Fn, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface HomeKeeperDemoStackProps extends StackProps {
  /** ARN of the HomeKeeper AgentCore runtime the simulator talks to. */
  runtimeArn: string;
  /** Public git repository the instance clones and builds. */
  repoUrl: string;
  gitRef?: string;
}

/**
 * Public demo of the simulated Alexa+ host.
 *
 *  - One small Arm EC2 instance in the default VPC clones the repo, builds the
 *    simulator, and runs it on port 80 under systemd. Its instance role can
 *    call Bedrock (Claude, Titan, Nova 2 Sonic), Polly, and the HomeKeeper
 *    runtime on AgentCore with SigV4.
 *  - CloudFront in front gives the demo HTTPS (the microphone needs a secure
 *    context) and passes the voice WebSocket and the SSE chat stream through.
 *    The instance only accepts traffic from CloudFront's origin-facing ranges.
 */
export class HomeKeeperDemoStack extends Stack {
  constructor(scope: Construct, id: string, props: HomeKeeperDemoStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "Vpc", { isDefault: true });

    const sg = new ec2.SecurityGroup(this, "Sg", { vpc, description: "HomeKeeper demo host: HTTP from CloudFront only", allowAllOutbound: true });
    // com.amazonaws.global.cloudfront.origin-facing (managed prefix list, us-east-1)
    sg.addIngressRule(ec2.Peer.prefixList("pl-3b927c52"), ec2.Port.tcp(80), "CloudFront origin-facing");

    const role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "HomeKeeper demo host: Bedrock, Polly, AgentCore invoke",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")]
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockModels",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModelWithBidirectionalStream"],
        resources: [`arn:aws:bedrock:*::foundation-model/*`, `arn:aws:bedrock:*:${this.account}:inference-profile/*`]
      })
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: "Polly", actions: ["polly:SynthesizeSpeech", "polly:DescribeVoices"], resources: ["*"] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeHomeKeeper",
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [props.runtimeArn, `${props.runtimeArn}/*`]
      })
    );

    const encodedArn = encodeURIComponent(props.runtimeArn);
    const mcpUrl = `https://bedrock-agentcore.${this.region}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;
    const ref = props.gitRef ?? "main";

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y git tar xz",
      "NODE_VERSION=22.12.0",
      'curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" | tar -xJ -C /usr/local --strip-components=1',
      "node --version",
      `git clone --depth 1 -b ${ref} ${props.repoUrl} /opt/homekeeper`,
      "cd /opt/homekeeper",
      "npm ci --no-audit --no-fund",
      "npm run build -w @homekeeper/ui",
      "npm run build -w @homekeeper/simulator",
      // Pull + rebuild + restart, for later updates: sudo /opt/homekeeper/redeploy.sh
      "cat > /opt/homekeeper/redeploy.sh <<'EOF'\n#!/bin/bash\nset -euxo pipefail\ncd /opt/homekeeper\ngit fetch --depth 1 origin " +
        ref +
        "\ngit reset --hard FETCH_HEAD\nnpm ci --no-audit --no-fund\nnpm run build -w @homekeeper/ui\nnpm run build -w @homekeeper/simulator\nsystemctl restart homekeeper\nEOF",
      "chmod +x /opt/homekeeper/redeploy.sh",
      "cat > /etc/systemd/system/homekeeper.service <<'EOF'\n[Unit]\nDescription=HomeKeeper simulated Alexa+ host\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nWorkingDirectory=/opt/homekeeper/packages/simulator\nEnvironment=PORT=80\nEnvironment=AWS_REGION=" +
        this.region +
        "\nEnvironment=HOST_MODE=bedrock\nEnvironment=HOUSEHOLD_ID=demo-home\nEnvironment=MCP_URL=" +
        mcpUrl +
        "\nExecStart=/usr/local/bin/npx tsx src/server/index.ts\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\nEOF",
      "systemctl daemon-reload",
      "systemctl enable --now homekeeper"
    );

    const instance = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: sg,
      role,
      userData,
      blockDevices: [{ deviceName: "/dev/xvda", volume: ec2.BlockDeviceVolume.ebs(16, { volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      requireImdsv2: true
    });

    const eip = new ec2.CfnEIP(this, "Eip", { domain: "vpc", instanceId: instance.instanceId });
    // Elastic IPs resolve to ec2-a-b-c-d.compute-1.amazonaws.com in us-east-1; CloudFront needs a DNS name, not an IP.
    const originDns = Fn.join("", ["ec2-", Fn.join("-", Fn.split(".", eip.ref)), ".compute-1.amazonaws.com"]);

    const dist = new cloudfront.Distribution(this, "Dist", {
      comment: "HomeKeeper: simulated Alexa+ host",
      defaultBehavior: {
        origin: new origins.HttpOrigin(originDns, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          readTimeout: Duration.seconds(60),
          keepaliveTimeout: Duration.seconds(60)
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3
    });

    new CfnOutput(this, "DemoUrl", { value: `https://${dist.distributionDomainName}` });
    new CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new CfnOutput(this, "ElasticIp", { value: eip.ref });
    new CfnOutput(this, "McpUrl", { value: mcpUrl });
  }
}
