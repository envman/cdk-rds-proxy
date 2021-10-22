import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { APIGatewayProxyResult } from "aws-lambda";
import { knex } from "knex";
import * as AWS from "aws-sdk";

const getDbConnection = async () => {
  const region = process.env.AWS_REGION;
  const rdsClusterSecretArn = process.env.RDS_SECRET_NAME;
  const proxyEndpoint = process.env.PROXY_ENDPOINT;

  const secretsManager = new SecretsManagerClient({ region });
  const getSecretValueCommand = new GetSecretValueCommand({
    SecretId: rdsClusterSecretArn,
  });

  const rdsClusterSecret = await secretsManager.send(getSecretValueCommand);

  if (!rdsClusterSecret.SecretString)
    throw new Error("No RDS secret string in rds cluster secrets");

  const secrets = JSON.parse(rdsClusterSecret.SecretString);

  const signer = new AWS.RDS.Signer({
    region,
    hostname: proxyEndpoint,
    port: secrets.port,
    username: secrets.username,
  });

  const token = await new Promise<string>((resolve, reject) => {
    signer.getAuthToken({}, (err: AWS.AWSError, token: string) => {
      if (err) return reject(err);

      resolve(token);
    });
  });

  console.log("token", token);

  return knex({
    client: "pg",
    connection: {
      // token,
      host: proxyEndpoint,
      port: secrets.port,
      user: secrets.username,
      // password: token,
      password: secrets.password,
      database: secrets.dbname,
      ssl: true
    },
    // pool: {
    //   afterCreate: (connection: any, cb: any) => {
    //     console.log('afterCreate', connection)
    //     cb()
    //   },
    // }
  });
};

const handler = async (): Promise<APIGatewayProxyResult> => {
  console.log("handler starting");

  const db = await getDbConnection();
  console.log("has db connection");

  // await db('test').select()
  const exists = await db.schema.hasTable("test_table");
  console.log("exists", exists);
  //   if (!exists) {
  //     await db.schema.createTable("test_table", (table) => {
  //       table.increments("id").primary();
  //       table.string("name");
  //     });
  //   }

  return {
    statusCode: 200,
    body: "Nothing Broke?",
  };
};

export { handler };
