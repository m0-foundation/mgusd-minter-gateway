/**
 * `npm run cli -- roles` — print a table of which roles are configured in
 * the current environment. Doesn't validate anything beyond presence of
 * `*_PUBLIC_KEY` + `*_FIREBLOCKS_VAULT_ACCOUNT_ID`, so it works with zero
 * Fireblocks creds set.
 */
export function runRolesCommand(): void {
  const roles = [
    { name: "ADMIN", pkVar: "ADMIN_PUBLIC_KEY", vaultVar: "ADMIN_FIREBLOCKS_VAULT_ACCOUNT_ID" },
    { name: "MINTER", pkVar: "MINTER_PUBLIC_KEY", vaultVar: "MINTER_FIREBLOCKS_VAULT_ACCOUNT_ID" },
    { name: "PAUSER", pkVar: "PAUSER_PUBLIC_KEY", vaultVar: "PAUSER_FIREBLOCKS_VAULT_ACCOUNT_ID" },
    { name: "BLOCK_OPERATOR", pkVar: "BLOCK_OPERATOR_PUBLIC_KEY", vaultVar: "BLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID" },
    { name: "UNBLOCK_OPERATOR", pkVar: "UNBLOCK_OPERATOR_PUBLIC_KEY", vaultVar: "UNBLOCK_OPERATOR_FIREBLOCKS_VAULT_ACCOUNT_ID" },
    { name: "FORCED_TRANSFER_MANAGER", pkVar: "FORCED_TRANSFER_MANAGER_PUBLIC_KEY", vaultVar: "FORCED_TRANSFER_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID" },
    { name: "YIELD_RECIPIENT_MANAGER", pkVar: "YIELD_RECIPIENT_MANAGER_PUBLIC_KEY", vaultVar: "YIELD_RECIPIENT_MANAGER_FIREBLOCKS_VAULT_ACCOUNT_ID" },
    { name: "ISSUER", pkVar: "ISSUER_PUBLIC_KEY", vaultVar: "ISSUER_FIREBLOCKS_VAULT_ACCOUNT_ID" },
  ];

  console.log("Role".padEnd(28) + "Configured  " + "Vault  " + "Public key");
  console.log("─".repeat(28) + "─".repeat(12) + "─".repeat(7) + "─".repeat(20));
  for (const r of roles) {
    const pk = process.env[r.pkVar];
    const vault = process.env[r.vaultVar];
    const configured = pk && vault ? "yes" : pk || vault ? "partial" : "no";
    const vaultDisp = vault ?? "—";
    const pkDisp = pk ? `${pk.slice(0, 8)}…` : "—";
    console.log(`${r.name.padEnd(28)}${configured.padEnd(12)}${vaultDisp.padEnd(7)}${pkDisp}`);
  }
}
