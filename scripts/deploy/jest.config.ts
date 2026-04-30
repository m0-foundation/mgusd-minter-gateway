import type { Config } from "jest";

const config: Config = {
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  testEnvironment: "node",
};

export default config;
