/* istanbul ignore file */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { APIGatewayProxyResult } from "aws-lambda";
import { knex } from "knex";
// import * as a from 'knex/lib/dialects/postgres/query'

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

  console.log('proxyEndpoint', proxyEndpoint)
  console.log('secrets', secrets)

  return knex({
    client: "pg",
    connection: {
      // host: secrets.host,
      host: proxyEndpoint,
      port: secrets.port,
      user: secrets.username,
      password: secrets.password,
      // password: 'WRONG',
      database: secrets.dbname,
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
  console.log('handler starting');

  const db = await getDbConnection();
  console.log('has db connection');

  // await db('test').select()
  const exists = await db.schema.hasTable("test_table");
  console.log('exists', exists);
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
