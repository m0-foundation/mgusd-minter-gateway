import { loadConfig } from "./config";
import { Reconciler } from "./reconciler";
import { Storage } from "./storage";
import { BurnTracker } from "./tracker";

export async function handler(): Promise<void> {
  const config = await loadConfig();
  const storage = new Storage(config.awsRegion, config.burnsTableName, config.stateTableName);
  const reconciler = new Reconciler(config, storage);
  const tracker = new BurnTracker(config, storage, reconciler);
  await tracker.run();
}
