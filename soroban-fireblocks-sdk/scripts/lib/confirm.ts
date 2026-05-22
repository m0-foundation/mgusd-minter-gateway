import * as readline from "readline";

/**
 * Interactive y/N prompt. Resolves true only on explicit "y" / "yes".
 * Anything else (including empty input) resolves false.
 *
 * Scripts can skip the prompt with `--yes` on argv.
 */
export async function confirm(message: string, argv: string[] = process.argv): Promise<boolean> {
  if (argv.includes("--yes")) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N]: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}
