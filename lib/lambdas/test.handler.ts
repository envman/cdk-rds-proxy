import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { APIGatewayProxyResult } from "aws-lambda";
import { Pool } from "pg";
import * as AWS from "aws-sdk";

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

  // console.log("token", token);

  // const pem = await fs.readFile(path.join(__dirname, 'eu-west-1-bundle.pem'), 'utf8');

  return new Pool({
    // host: proxyEndpoint,
    host: secrets.host,
    port: secrets.port,
    user: secrets.username,
    password: secrets.password,
    // password: token,
    database: secrets.dbname,
    // ssl: true
  });
};

const createUser = async (pool: Pool) => {
  await pool.query('CREATE USER test_user WITH LOGIN; GRANT rds_iam to test_user');
}

const handler = async (): Promise<APIGatewayProxyResult> => {
  console.log("handler starting");

  const pool = await getConnectionPool();
  console.log("has db connection");

  // const client = await pool.connect();
  // await createUser(pool);
  
  const result = await pool.query('SELECT * FROM information_schema.tables');

  // console.log('result', result);

  await pool.end();
  console.log("disconnected from DB");

  return {
    statusCode: 200,
    body: "Nothing Broke?",
  };
};

export { handler };
