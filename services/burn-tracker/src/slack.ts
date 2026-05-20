import { BurnRecord } from "./types";

export async function notifyBurn(webhookUrl: string, burn: BurnRecord): Promise<void> {
  const text = [
    `*New burn detected*`,
    `Amount: \`${burn.amount}\``,
    `From: \`${burn.from}\``,
    `Tx: \`${burn.txHash}\``,
    `Ledger: ${burn.ledger}`,
  ].join("\n");

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[slack] Webhook returned ${res.status}`);
    }
  } catch (err) {
    console.error("[slack] Failed to send notification:", err);
  }
}
