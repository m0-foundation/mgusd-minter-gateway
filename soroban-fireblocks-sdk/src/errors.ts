export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}

export class FireblocksSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FireblocksSigningError";
  }
}

export class SubmissionError extends Error {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

export class WasmHashMismatchError extends Error {
    constructor(
        message: string,
        public readonly expectedHash: string,
        public readonly actualHash: string | undefined,
        public readonly txHash?: string,
    ) {
        super(message);
        this.name = "WasmHashMismatchError";
    }
}

export interface IssuerContaminationCounts {
  trustlines: number;
  claimableBalances: number;
  liquidityPools: number;
  contracts: number;
}

export class IssuerContaminatedError extends Error {
  constructor(
    message: string,
    public readonly assetCode: string,
    public readonly assetIssuer: string,
    public readonly counts: IssuerContaminationCounts,
  ) {
    super(message);
    this.name = "IssuerContaminatedError";
  }
}
