import type { Config } from "jest";

const config: Config = {
  projects: [
    {
      displayName: "unit",
      testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
      transform: {
        "^.+\\.ts$": "ts-jest",
      },
    },
    {
      displayName: "integration",
      testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
      transform: {
        "^.+\\.ts$": "ts-jest",
      },
      testTimeout: 120_000,
    },
  ],
};

export default config;
