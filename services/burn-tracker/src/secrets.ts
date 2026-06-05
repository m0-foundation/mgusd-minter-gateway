import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export interface Secrets {
  fireblocksSecretKey: string;
  fireblocksApiKey: string;
  networkPassphrase: string;
  fireblocksVaultAccountId: string;
  adminPublicKey: string;
}

export async function fetchSecretsFromSsm(region: string): Promise<Secrets> {
  const ssm = new SSMClient({ region });

  async function get(envVar: string): Promise<string> {
    const path = process.env[envVar];
    if (!path) throw new Error(`Missing env var: ${envVar}`);
    const { Parameter } = await ssm.send(
      new GetParameterCommand({ Name: path, WithDecryption: true }),
    );
    if (!Parameter?.Value) throw new Error(`SSM parameter empty: ${path}`);
    return Parameter.Value;
  }

  const [fireblocksSecretKey, fireblocksApiKey, networkPassphrase, fireblocksVaultAccountId, adminPublicKey] =
    await Promise.all([
      get("SSM_FIREBLOCKS_SECRET_PATH"),
      get("SSM_FIREBLOCKS_API_KEY_PATH"),
      get("SSM_NETWORK_PASSPHRASE_PATH"),
      get("SSM_FIREBLOCKS_VAULT_ACCOUNT_ID_PATH"),
      get("SSM_ADMIN_PUBLIC_KEY_PATH"),
    ]);

  return { fireblocksSecretKey, fireblocksApiKey, networkPassphrase, fireblocksVaultAccountId, adminPublicKey };
}
