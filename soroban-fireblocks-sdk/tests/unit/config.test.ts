import * as fs from "fs";
import {
  loadConfigFromEnv,
  loadIssuerConfigFromEnv,
  loadMinterConfigFromEnv,
  validateConfig,
  readFireblocksSecret,
} from "../../src/config";
import { ConfigError } from "../../src/errors";
import { SorobanFireblocksConfig } from "../../src/types";

jest.mock("fs");

const mockedFs = fs as jest.Mocked<typeof fs>;

function validConfig(): SorobanFireblocksConfig {
  return {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    fireblocksApiKey: "fb-api-key",
    fireblocksSecretKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    fireblocksVaultAccountId: "0",
    fireblocksAssetId: "XLM_TEST",
    sourcePublicKey: "GABC123456789",
  };
}

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    expect(() => validateConfig(validConfig())).not.toThrow();
  });

  it.each([
    ["sorobanRpcUrl", "SOROBAN_RPC_URL"],
    ["horizonUrl", "HORIZON_URL"],
    ["networkPassphrase", "SOROBAN_NETWORK_PASSPHRASE"],
    ["fireblocksApiKey", "FIREBLOCKS_API_KEY"],
    ["fireblocksSecretKey", "Fireblocks secret key"],
    ["fireblocksVaultAccountId", "FIREBLOCKS_VAULT_ACCOUNT_ID"],
    ["fireblocksAssetId", "FIREBLOCKS_ASSET_ID"],
    ["sourcePublicKey", "SOURCE_PUBLIC_KEY"],
  ] as const)("throws ConfigError when %s is missing", (key, label) => {
    const config = validConfig();
    (config as unknown as Record<string, string>)[key] = "";
    expect(() => validateConfig(config)).toThrow(ConfigError);
    expect(() => validateConfig(config)).toThrow(label);
  });

  it("throws ConfigError when sourcePublicKey does not start with G", () => {
    const config = validConfig();
    config.sourcePublicKey = "SABC123456789";
    expect(() => validateConfig(config)).toThrow(ConfigError);
    expect(() => validateConfig(config)).toThrow("must be a valid Stellar public key");
  });
});

describe("readFireblocksSecret", () => {
  it("reads and returns file contents", () => {
    mockedFs.readFileSync.mockReturnValue("secret-pem-content");
    const result = readFireblocksSecret("/path/to/secret.key");
    expect(result).toBe("secret-pem-content");
    expect(mockedFs.readFileSync).toHaveBeenCalledWith("/path/to/secret.key", "utf-8");
  });

  it("throws ConfigError when file does not exist", () => {
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
    expect(() => readFireblocksSecret("/bad/path")).toThrow(ConfigError);
    expect(() => readFireblocksSecret("/bad/path")).toThrow("Failed to read Fireblocks secret");
  });
});

describe("loadConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      FIREBLOCKS_API_KEY: "fb-api-key",
      FIREBLOCKS_SECRET_PATH: "/path/to/secret.key",
      FIREBLOCKS_VAULT_ACCOUNT_ID: "0",
      FIREBLOCKS_ASSET_ID: "XLM_TEST",
      SOURCE_PUBLIC_KEY: "GABC123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads config from environment variables", () => {
    const config = loadConfigFromEnv();
    expect(config.sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.fireblocksApiKey).toBe("fb-api-key");
    expect(config.sourcePublicKey).toBe("GABC123456789");
  });

  it("throws ConfigError when FIREBLOCKS_SECRET_PATH is missing", () => {
    delete process.env.FIREBLOCKS_SECRET_PATH;
    expect(() => loadConfigFromEnv()).toThrow(ConfigError);
    expect(() => loadConfigFromEnv()).toThrow("FIREBLOCKS_SECRET_PATH");
  });
});

describe("loadIssuerConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      FIREBLOCKS_API_KEY: "fb-api-key",
      FIREBLOCKS_SECRET_PATH: "/path/to/secret.key",
      FIREBLOCKS_ASSET_ID: "XLM_TEST",
      ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID: "0",
      ISSUER_PUBLIC_KEY: "GISSUER123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads issuer config from ISSUER_ env vars", () => {
    const config = loadIssuerConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("0");
    expect(config.sourcePublicKey).toBe("GISSUER123456789");
    expect(config.fireblocksApiKey).toBe("fb-api-key");
  });

  it("throws ConfigError when ISSUER_PUBLIC_KEY is missing", () => {
    delete process.env.ISSUER_PUBLIC_KEY;
    expect(() => loadIssuerConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadIssuerConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when FIREBLOCKS_SECRET_PATH is missing", () => {
    delete process.env.FIREBLOCKS_SECRET_PATH;
    expect(() => loadIssuerConfigFromEnv()).toThrow(ConfigError);
    expect(() => loadIssuerConfigFromEnv()).toThrow("FIREBLOCKS_SECRET_PATH");
  });
});

describe("loadMinterConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      FIREBLOCKS_API_KEY: "fb-api-key",
      FIREBLOCKS_SECRET_PATH: "/path/to/secret.key",
      FIREBLOCKS_ASSET_ID: "XLM_TEST",
      MINTER_FIREBLOCKS_VAULT_ACCOUNT_ID: "1",
      MINTER_PUBLIC_KEY: "GMINTER123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads minter config from MINTER_ env vars", () => {
    const config = loadMinterConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("1");
    expect(config.sourcePublicKey).toBe("GMINTER123456789");
    expect(config.fireblocksApiKey).toBe("fb-api-key");
  });

  it("throws ConfigError when MINTER_PUBLIC_KEY is missing", () => {
    delete process.env.MINTER_PUBLIC_KEY;
    expect(() => loadMinterConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when MINTER_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.MINTER_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadMinterConfigFromEnv()).toThrow(ConfigError);
  });

  it("uses shared env vars for non-role fields", () => {
    const config = loadMinterConfigFromEnv();
    expect(config.sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(config.fireblocksAssetId).toBe("XLM_TEST");
  });
});
