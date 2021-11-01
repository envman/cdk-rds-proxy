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
import { CfnOutput } from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import { Policy } from '@aws-cdk/aws-iam';
import { Pool } from 'pg';
import { ApiGatewayManagementApi } from 'aws-sdk';
import { HttpMethod } from '@aws-cdk/aws-apigatewayv2';
import { LambdaProxyIntegration } from '@aws-cdk/aws-apigatewayv2-integrations';

export class RdsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2, // Default is all AZs in the region
    });

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

    // new iam.PolicyDocument({
    //   statements: [
    //     new iam.PolicyStatement({
    //       actions: ['rds-db:connect'],
    //       resources: [
    //         '*',
    //         // `arn:aws:rds-db:${}:${}:dbuser:${DBResourceId}/${DBUsername}`
    //       ],
    //     })
    //   ]
    // })

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
        //   subnetType: ec2.SubnetType.PUBLIC,
        // },
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
      requireTLS: true,
      // iamAuth: true
    });

    new CfnOutput(this, 'proxy-id', { value: proxy.dbProxyName })
    
    // Workaround for bug where TargetGroupName is not set but required
    let targetGroup = proxy.node.children.find((child:any) => {
      return child instanceof rds.CfnDBProxyTargetGroup
    }) as rds.CfnDBProxyTargetGroup

    targetGroup.addPropertyOverride('TargetGroupName', 'default');
    
    const createUserLambda = new lambda.NodejsFunction(this, 'createUserHandler', {
      runtime: Runtime.NODEJS_14_X,
      entry: path.join(__dirname, 'lambdas', 'create-user.handler.ts'),
      vpc,
      securityGroups: [dbConnectionGroup],
      environment: {
        // PROXY_ENDPOINT: proxy.endpoint,
        RDS_SECRET_NAME: id + '-rds-credentials'
      },
      bundling: {
        nodeModules: ['pg']
      },
    })
    new CfnOutput(this, 'createUserLambda', { value: createUserLambda.functionName })

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

    new CfnOutput(this, 'RDSLambdaID', { value: rdsLambda.functionName })

    databaseCredentialsSecret.grantRead(rdsLambda);
    
    let api = new apigw.HttpApi(this, 'Endpoint', {
      // defaultIntegration: new integrations.LambdaProxyIntegration({
      //   handler: rdsLambda
      // })
    });

    databaseCredentialsSecret.grantRead(createUserLambda);
    api.addRoutes({
      path: '/create-user',
      methods: [HttpMethod.GET],
      integration: new LambdaProxyIntegration({
        handler: createUserLambda
      })
    })

    const proxyOnlyHandler = new lambda.NodejsFunction(this, 'proxyOnlyHandler', {
      runtime: Runtime.NODEJS_14_X,
      entry: path.join(__dirname, 'lambdas', 'proxy-only.handler.ts'),
      vpc,
      securityGroups: [lambdaToRDSProxyGroup],
      environment: {
        PROXY_ENDPOINT: proxy.endpoint,
        RDS_SECRET_NAME: id + '-rds-credentials'
      },
      bundling: {
        nodeModules: ['pg']
      },
    })
    new CfnOutput(this, 'proxyOnlyLambda', { value: proxyOnlyHandler.functionName })

    databaseCredentialsSecret.grantRead(proxyOnlyHandler);
    api.addRoutes({
      path: '/proxy-only',
      methods: [HttpMethod.GET],
      integration: new LambdaProxyIntegration({
        handler: proxyOnlyHandler
      })
    })

    new cdk.CfnOutput(this, 'HTTP API Url', {
      value: api.url ?? 'Something went wrong with the deploy'
    });
  }
}
