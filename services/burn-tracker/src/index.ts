import http from "http";
import { loadConfig } from "./config";
import { Reconciler } from "./reconciler";
import { Storage } from "./storage";
import { BurnTracker } from "./tracker";

function startApiServer(storage: Storage, port: number): void {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/pending-amount") {
      const amount = storage.getPendingAmount();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending_amount: amount }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[burn-tracker] API listening on port ${port}`);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config.dbPath);
  const reconciler = new Reconciler(config, storage);
  const tracker = new BurnTracker(config, storage, reconciler);

  if (config.apiEnabled) {
    startApiServer(storage, config.apiPort);
  }

  await tracker.run();
}

main().catch((err) => {
  console.error("[burn-tracker] Fatal:", err);
  process.exit(1);
});
