import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { APIGatewayProxyResult } from "aws-lambda";
import { Pool } from "pg";

const getConnectionPool = async () => {
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

  return new Pool({
    host: proxyEndpoint,
    port: secrets.port,
    user: secrets.username,
    password: secrets.password,
    database: secrets.dbname,
    ssl: true,
  });
};

const handler = async (): Promise<APIGatewayProxyResult> => {
  console.log("handler starting");

  const pool = await getConnectionPool();
  console.log("has db connection");

  const result = await pool.query("SELECT * FROM information_schema.tables");
  console.log("result", result);

  await pool.end();
  console.log("disconnected from DB");

  console.log('test');

  return {
    statusCode: 200,
    body: "Nothing Broke?",
  };
};

export { handler };
