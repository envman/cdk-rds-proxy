import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { APIGatewayProxyResult } from "aws-lambda";
import { Pool } from "pg";

const getConnectionPool = async () => {
  const region = process.env.AWS_REGION;
  const rdsClusterSecretArn = process.env.RDS_SECRET_NAME;

  const secretsManager = new SecretsManagerClient({ region });
  const getSecretValueCommand = new GetSecretValueCommand({
    SecretId: rdsClusterSecretArn,
  });

  const rdsClusterSecret = await secretsManager.send(getSecretValueCommand);

  if (!rdsClusterSecret.SecretString)
    throw new Error("No RDS secret string in rds cluster secrets");

  const secrets = JSON.parse(rdsClusterSecret.SecretString);

  return new Pool({
    host: secrets.host,
    port: secrets.port,
    user: secrets.username,
    password: secrets.password,
    database: secrets.dbname,
    ssl: true,
  });
};

const createUser = async (pool: Pool) => {
  await pool.query(
    "CREATE USER test_user WITH LOGIN; GRANT rds_iam to test_user"
  );
};

const handler = async (): Promise<APIGatewayProxyResult> => {
  console.log("handler starting");

  const pool = await getConnectionPool();
  console.log("has db connection");

  await createUser(pool);
  console.log('User Created');

  await pool.end();
  console.log("disconnected from DB");

  return {
    statusCode: 200,
    body: "User Created",
  };
};

export { handler };
