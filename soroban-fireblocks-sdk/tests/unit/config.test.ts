import * as fs from "fs";
import {
  loadConfigFromEnv,
  loadIssuerConfigFromEnv,
  loadMinterConfigFromEnv,
  loadPauserConfigFromEnv,
  loadAdminConfigFromEnv,
  loadBlockOperatorConfigFromEnv,
  loadUnblockOperatorConfigFromEnv,
  loadForcedTransferManagerConfigFromEnv,
  loadYieldRecipientManagerConfigFromEnv,
  loadReadOnlyConfigFromEnv,
  validateConfig,
  validateReadOnlyConfig,
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

describe("loadPauserConfigFromEnv", () => {
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
      PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID: "2",
      PAUSER_PUBLIC_KEY: "GPAUSER123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads pauser config from PAUSER_ env vars", () => {
    const config = loadPauserConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("2");
    expect(config.sourcePublicKey).toBe("GPAUSER123456789");
    expect(config.fireblocksApiKey).toBe("fb-api-key");
  });

  it("throws ConfigError when PAUSER_PUBLIC_KEY is missing", () => {
    delete process.env.PAUSER_PUBLIC_KEY;
    expect(() => loadPauserConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadPauserConfigFromEnv()).toThrow(ConfigError);
  });
});

describe("loadAdminConfigFromEnv", () => {
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
      ADMIN_FIREBLOCKS_VAULT_ACCOUNT_ID: "3",
      ADMIN_PUBLIC_KEY: "GADMIN123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads admin config from ADMIN_ env vars", () => {
    const config = loadAdminConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("3");
    expect(config.sourcePublicKey).toBe("GADMIN123456789");
  });

  it("throws ConfigError when ADMIN_PUBLIC_KEY is missing", () => {
    delete process.env.ADMIN_PUBLIC_KEY;
    expect(() => loadAdminConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when ADMIN_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.ADMIN_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadAdminConfigFromEnv()).toThrow(ConfigError);
  });
});

describe("loadBlockOperatorConfigFromEnv", () => {
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
      BLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID: "4",
      BLOCK_OPERATOR_PUBLIC_KEY: "GBLOCK123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads block operator config from BLOCK_OPERATOR_ env vars", () => {
    const config = loadBlockOperatorConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("4");
    expect(config.sourcePublicKey).toBe("GBLOCK123456789");
  });

  it("throws ConfigError when BLOCK_OPERATOR_PUBLIC_KEY is missing", () => {
    delete process.env.BLOCK_OPERATOR_PUBLIC_KEY;
    expect(() => loadBlockOperatorConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when BLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.BLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadBlockOperatorConfigFromEnv()).toThrow(ConfigError);
  });
});

describe("loadUnblockOperatorConfigFromEnv", () => {
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
      UNBLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID: "5",
      UNBLOCK_OPERATOR_PUBLIC_KEY: "GUNBLOCK123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads unblock operator config from UNBLOCK_OPERATOR_ env vars", () => {
    const config = loadUnblockOperatorConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("5");
    expect(config.sourcePublicKey).toBe("GUNBLOCK123456789");
  });

  it("throws ConfigError when UNBLOCK_OPERATOR_PUBLIC_KEY is missing", () => {
    delete process.env.UNBLOCK_OPERATOR_PUBLIC_KEY;
    expect(() => loadUnblockOperatorConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when UNBLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.UNBLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadUnblockOperatorConfigFromEnv()).toThrow(ConfigError);
  });
});

describe("loadForcedTransferManagerConfigFromEnv", () => {
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
      FORCED_TRANSFER_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID: "6",
      FORCED_TRANSFER_MANAGER_PUBLIC_KEY: "GFTM123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads forced_transfer_manager config from FORCED_TRANSFER_MANAGER_ env vars", () => {
    const config = loadForcedTransferManagerConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("6");
    expect(config.sourcePublicKey).toBe("GFTM123456789");
  });

  it("throws ConfigError when FORCED_TRANSFER_MANAGER_PUBLIC_KEY is missing", () => {
    delete process.env.FORCED_TRANSFER_MANAGER_PUBLIC_KEY;
    expect(() => loadForcedTransferManagerConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when FORCED_TRANSFER_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.FORCED_TRANSFER_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadForcedTransferManagerConfigFromEnv()).toThrow(ConfigError);
  });
});

describe("loadYieldRecipientManagerConfigFromEnv", () => {
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
      YIELD_RECIPIENT_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID: "7",
      YIELD_RECIPIENT_MANAGER_PUBLIC_KEY: "GYRM123456789",
    };
    mockedFs.readFileSync.mockReturnValue("-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads yield_recipient_manager config from YIELD_RECIPIENT_MANAGER_ env vars", () => {
    const config = loadYieldRecipientManagerConfigFromEnv();
    expect(config.fireblocksVaultAccountId).toBe("7");
    expect(config.sourcePublicKey).toBe("GYRM123456789");
  });

  it("throws ConfigError when YIELD_RECIPIENT_MANAGER_PUBLIC_KEY is missing", () => {
    delete process.env.YIELD_RECIPIENT_MANAGER_PUBLIC_KEY;
    expect(() => loadYieldRecipientManagerConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when YIELD_RECIPIENT_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID is missing", () => {
    delete process.env.YIELD_RECIPIENT_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID;
    expect(() => loadYieldRecipientManagerConfigFromEnv()).toThrow(ConfigError);
  });
});

describe("validateReadOnlyConfig", () => {
  it("passes when read-only fields are set, even with empty Fireblocks fields", () => {
    expect(() =>
      validateReadOnlyConfig({
        sorobanRpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        fireblocksApiKey: "",
        fireblocksSecretKey: "",
        fireblocksVaultAccountId: "",
        fireblocksAssetId: "",
        sourcePublicKey: "",
      }),
    ).not.toThrow();
  });

  it("throws when SOROBAN_RPC_URL is missing", () => {
    expect(() =>
      validateReadOnlyConfig({
        sorobanRpcUrl: "",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        fireblocksApiKey: "",
        fireblocksSecretKey: "",
        fireblocksVaultAccountId: "",
        fireblocksAssetId: "",
        sourcePublicKey: "",
      }),
    ).toThrow(/SOROBAN_RPC_URL/);
  });

  it("throws when SOROBAN_NETWORK_PASSPHRASE is missing", () => {
    expect(() =>
      validateReadOnlyConfig({
        sorobanRpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "",
        fireblocksApiKey: "",
        fireblocksSecretKey: "",
        fireblocksVaultAccountId: "",
        fireblocksAssetId: "",
        sourcePublicKey: "",
      }),
    ).toThrow(/NETWORK_PASSPHRASE/);
  });
});

describe("loadReadOnlyConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads only the read-side shared env vars, ignoring missing Fireblocks creds", () => {
    delete process.env.FIREBLOCKS_API_KEY;
    delete process.env.FIREBLOCKS_SECRET_PATH;
    delete process.env.FIREBLOCKS_VAULT_ACCOUNT_ID;
    delete process.env.FIREBLOCKS_ASSET_ID;
    process.env.VIEW_SOURCE_PUBLIC_KEY = "GADV2Q7MVEVOJ7C5QK4P6IN6H5MPMTSM3YPG5IDAJ7ZMXQTNCLUIUJRE";

    const config = loadReadOnlyConfigFromEnv();
    expect(config.sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    expect(config.networkPassphrase).toBe("Test SDF Network ; September 2015");
    // Fireblocks fields are present (empty) but not required for view-only ops
    expect(config.fireblocksApiKey).toBe("");
    // sourcePublicKey is required for Soroban view simulation (needs a funded
    // source account for fee/seq) and falls back to VIEW_SOURCE_PUBLIC_KEY or
    // any *_PUBLIC_KEY in the environment.
    expect(config.sourcePublicKey).toBe("GADV2Q7MVEVOJ7C5QK4P6IN6H5MPMTSM3YPG5IDAJ7ZMXQTNCLUIUJRE");
  });

  it("falls back to BLOCK_OPERATOR_PUBLIC_KEY when VIEW_SOURCE_PUBLIC_KEY is unset", () => {
    delete process.env.VIEW_SOURCE_PUBLIC_KEY;
    process.env.BLOCK_OPERATOR_PUBLIC_KEY = "GD4KTM3SWERNNEPHCFWR2J4Q2VM6UUN54HYVLO6AEQTUSS7HCMDK5BRP";

    const config = loadReadOnlyConfigFromEnv();
    expect(config.sourcePublicKey).toBe("GD4KTM3SWERNNEPHCFWR2J4Q2VM6UUN54HYVLO6AEQTUSS7HCMDK5BRP");
  });

  it("throws ConfigError when no source pubkey is available", () => {
    delete process.env.VIEW_SOURCE_PUBLIC_KEY;
    for (const k of Object.keys(process.env)) {
      if (k.endsWith("_PUBLIC_KEY")) delete process.env[k];
    }
    expect(() => loadReadOnlyConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when SOROBAN_RPC_URL is missing", () => {
    process.env.VIEW_SOURCE_PUBLIC_KEY = "GADV2Q7MVEVOJ7C5QK4P6IN6H5MPMTSM3YPG5IDAJ7ZMXQTNCLUIUJRE";
    delete process.env.SOROBAN_RPC_URL;
    expect(() => loadReadOnlyConfigFromEnv()).toThrow(ConfigError);
  });

  it("throws ConfigError when HORIZON_URL is missing", () => {
    process.env.VIEW_SOURCE_PUBLIC_KEY = "GADV2Q7MVEVOJ7C5QK4P6IN6H5MPMTSM3YPG5IDAJ7ZMXQTNCLUIUJRE";
    delete process.env.HORIZON_URL;
    expect(() => loadReadOnlyConfigFromEnv()).toThrow(ConfigError);
  });
});
