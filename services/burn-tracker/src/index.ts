import { loadConfig } from "./config";
import { Reconciler } from "./reconciler";
import { Storage } from "./storage";
import { BurnTracker } from "./tracker";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config.storageFile);
  const reconciler = new Reconciler(config, storage);
  const tracker = new BurnTracker(config, storage, reconciler);
  await tracker.run();
}

main().catch((err) => {
  console.error("[burn-tracker] Fatal:", err);
  process.exit(1);
});
