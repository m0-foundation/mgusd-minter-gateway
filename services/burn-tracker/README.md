# burn-tracker

Monitors the Stellar Asset Contract (SAC) for burn events and submits `reconcile_burn` transactions via Fireblocks.

On each invocation the service:
1. Fetches all SAC burn events from the last saved ledger cursor up to the current latest ledger.
2. Skips burns that originated from the wrapper contract (those are already handled on-chain).
3. Calls `reconcile_burn` on the wrapper contract for each new direct burn via the Fireblocks admin signer.
4. Retries any previously unreconciled burns from prior runs.
5. Persists the ledger cursor and all burn records in DynamoDB so the next invocation resumes from where it left off.

The service is designed to run as an **AWS Lambda function** triggered by EventBridge Scheduler.

## DynamoDB setup

Two tables must be created before first run.

```bash
aws dynamodb create-table \
  --table-name Burns \
  --attribute-definitions \
    AttributeName=tx_hash,AttributeType=S \
    AttributeName=operation_index,AttributeType=N \
  --key-schema \
    AttributeName=tx_hash,KeyType=HASH \
    AttributeName=operation_index,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

aws dynamodb create-table \
  --table-name BurnTrackerState \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Table names can be overridden via `BURNS_TABLE_NAME` and `STATE_TABLE_NAME`.

## Configuration

Copy `.env.example` to `.env` and fill in the values (used for local runs only — on Lambda set these as environment variables).

| Variable | Required | Default | Description |
|---|---|---|---|
| `HORIZON_URL` | | `https://horizon-testnet.stellar.org` | Stellar Horizon endpoint |
| `ASSET_CODE` | yes | | Asset code to track (e.g. `USDM`) |
| `ASSET_ISSUER` | yes | | Asset issuer address (`G...`) |
| `START_LEDGER` | yes | | Ledger to start scanning from on first run |
| `AWS_REGION` | | `us-east-1` | AWS region for DynamoDB |
| `BURNS_TABLE_NAME` | | `Burns` | DynamoDB table for burn records |
| `STATE_TABLE_NAME` | | `BurnTrackerState` | DynamoDB table for ledger cursor |
| `CONTRACT_ID` | yes | | Wrapper contract address (`C...`) |
| `SAC_CONTRACT_ID` | yes | | SAC contract address (`C...`) |
| `SOROBAN_RPC_URL` | yes | | Soroban RPC endpoint |
| `SOROBAN_NETWORK_PASSPHRASE` | yes* | | Stellar network passphrase |
| `FIREBLOCKS_API_KEY` | yes* | | Fireblocks API key |
| `FIREBLOCKS_SECRET_PATH` | yes* | | Path to Fireblocks API secret PEM file |
| `FIREBLOCKS_VAULT_ACCOUNT_ID` | yes* | | Fireblocks vault account ID |
| `FIREBLOCKS_ASSET_ID` | yes* | | Fireblocks asset ID (e.g. `XLM`, `XLM_TEST`) |
| `FIREBLOCKS_BASE_PATH` | | `sandbox` | Fireblocks base path (`sandbox` or `prod`) |
| `ADMIN_PUBLIC_KEY` | yes* | | Admin signer public key (`G...`) |
| `DRY_RUN` | | `false` | Detect and store burns without submitting transactions |
| `SLACK_WEBHOOK_URL` | | | Slack incoming webhook URL for burn notifications |

\* Not required when `DRY_RUN=true`.

## Running locally

```bash
npm install
npm start
```

Requires a `.env` file with all necessary variables. Uses `ts-node` — no build step needed.

## Building for Lambda

```bash
npm install
npm run build
```

Produces `dist/lambda.js` — a single bundled file with all dependencies included.

**Deploy:**
1. Zip the output: `zip dist/lambda.zip dist/lambda.js`
2. Upload to Lambda (runtime: Node.js 20.x, handler: `dist/lambda.handler`)
3. Set all required environment variables in the Lambda configuration
4. Add an EventBridge Scheduler trigger with the desired interval

The Lambda execution role must have `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, and `dynamodb:Scan` permissions on both DynamoDB tables.
