import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as rds from '@aws-cdk/aws-rds';
import * as secrets from '@aws-cdk/aws-secretsmanager';
import * as ssm from '@aws-cdk/aws-ssm';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as apigw from '@aws-cdk/aws-apigatewayv2';
import * as integrations from '@aws-cdk/aws-apigatewayv2-integrations';
import { Runtime } from '@aws-cdk/aws-lambda';
import * as path from 'path';
import { CfnOutput, Duration } from '@aws-cdk/core';

export class RdsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2, // Default is all AZs in the region
    });

    // const vpc = ec2.Vpc.fromLookup(this, "VpcLookup", {
    //   isDefault: true
    // });

    let lambdaToRDSProxyGroup = new ec2.SecurityGroup(this, 'Lambda to RDS Proxy Connection', {
      vpc
    });
    let dbConnectionGroup = new ec2.SecurityGroup(this, 'Proxy to DB Connection', {
      vpc
    });
    dbConnectionGroup.addIngressRule(dbConnectionGroup, ec2.Port.tcp(3306), 'allow db connection');
    dbConnectionGroup.addIngressRule(lambdaToRDSProxyGroup, ec2.Port.tcp(3306), 'allow lambda connection');

    const databaseUsername = 'syscdk';
    const databaseCredentialsSecret = new secrets.Secret(this, 'DBCredentialsSecret', {
      secretName: id + '-rds-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: databaseUsername,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    new ssm.StringParameter(this, 'DBCredentialsArn', {
      parameterName: 'rds-credentials-arn',
      stringValue: databaseCredentialsSecret.secretArn,
    });

    const rdsCluster = new rds.DatabaseCluster(this, "RdsCluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_11_9,
      }),
      defaultDatabaseName: "ownership_service_db",
      instances: 1,
      instanceProps: {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE3,
          ec2.InstanceSize.MEDIUM
        ),
        // vpcSubnets: {
        //   subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        // },
        vpc,
        // enablePerformanceInsights: true,
        securityGroups: [dbConnectionGroup]
      },
      credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      iamAuthentication: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    rdsCluster.connections.allowFrom(lambdaToRDSProxyGroup, ec2.Port.tcp(5432));

    // Create an RDS Proxy
    const proxy = rdsCluster.addProxy(id+'-proxy', {
        secrets: [databaseCredentialsSecret],
        debugLogging: true,
        vpc,
        securityGroups: [dbConnectionGroup],
        requireTLS: false
    });

    new CfnOutput(this, 'proxy-id', { value: proxy.dbProxyName })
    
    // Workaround for bug where TargetGroupName is not set but required
    let targetGroup = proxy.node.children.find((child:any) => {
      return child instanceof rds.CfnDBProxyTargetGroup
    }) as rds.CfnDBProxyTargetGroup

    targetGroup.addPropertyOverride('TargetGroupName', 'default');
    
    const rdsLambda = new lambda.NodejsFunction(this, 'rdsProxyHandler', {
      runtime: Runtime.NODEJS_14_X,
      entry: path.join(__dirname, 'lambdas', 'test.handler.ts'),
      vpc,
      securityGroups: [lambdaToRDSProxyGroup],
      environment: {
        PROXY_ENDPOINT: proxy.endpoint,
        RDS_SECRET_NAME: id + '-rds-credentials'
      },
      bundling: {
        nodeModules: ['knex', 'pg']
      },
    })

    new CfnOutput(this, 'LambdaId', { value: rdsLambda.functionName })

    databaseCredentialsSecret.grantRead(rdsLambda);

    // defines an API Gateway Http API resource backed by our "rdsLambda" function.
    let api = new apigw.HttpApi(this, 'Endpoint', {
      defaultIntegration: new integrations.LambdaProxyIntegration({
        handler: rdsLambda
      })
    });

    new cdk.CfnOutput(this, 'HTTP API Url', {
      value: api.url ?? 'Something went wrong with the deploy'
    });
  }
}
