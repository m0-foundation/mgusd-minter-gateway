import * as readline from "readline";

/**
 * Interactive y/N prompt. Resolves true only on explicit "y" / "yes".
 * Anything else (including empty input) resolves false.
 */
export async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N]: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}
