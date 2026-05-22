/**
 * Builds the human-readable note attached to every Fireblocks RAW signing
 * request. Approvers see this on their mobile push and in the Fireblocks
 * console next to the (otherwise opaque) 32-byte hash they're being asked
 * to sign. Without it, RAW signing offers zero context about the underlying
 * transaction.
 *
 * Fireblocks notes are capped (~255 chars in practice). This helper produces
 * a compact multi-line format that fits within that budget for every method
 * defined in this SDK, and truncates conservatively if a caller exceeds it.
 */

const MAX_NOTE_LENGTH = 250;

export interface FireblocksNoteInput {
  /** e.g. "mintergateway" — the contract module / protocol the call belongs to. */
  protocol: string;
  /** Contract method name (snake_case), e.g. "block_user". */
  method: string;
  /** Wrapper contract ID (C...). */
  contract: string;
  /** Signer/caller pubkey (G...) — the Fireblocks vault's Stellar address. */
  caller: string;
  /** Human-readable args, in call order. Empty for no-arg calls. */
  args?: Record<string, string | number | bigint>;
}

export function buildFireblocksNote(input: FireblocksNoteInput): string {
  const argsBlock =
    input.args && Object.keys(input.args).length > 0
      ? "\n" +
        Object.entries(input.args)
          .map(([k, v]) => `  ${k}: ${formatArgValue(v)}`)
          .join("\n")
      : "";

  const note =
    `${input.protocol}::${input.method}` +
    argsBlock +
    `\n  contract: ${input.contract}` +
    `\n  caller:   ${input.caller}`;

  if (note.length <= MAX_NOTE_LENGTH) return note;
  // Truncation is a last resort — caller should keep args short. If we hit
  // this, the approver still sees method + truncation marker so they know
  // something was elided.
  return note.slice(0, MAX_NOTE_LENGTH - 3) + "...";
}

function formatArgValue(v: string | number | bigint): string {
  if (typeof v === "bigint") return v.toString();
  return String(v);
}
