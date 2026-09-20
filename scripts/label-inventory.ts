import { GmailClient } from "../src/gmail/client";
import { createAccessTokenSource } from "../src/gmail/tokens";
import { buildMigrationPlan } from "../src/services/labels";
import { loadDevVars } from "./lib/dev-vars";

const main = async (): Promise<void> => {
  const devVars = loadDevVars();
  const read = (key: string): string | undefined => process.env[key] ?? devVars[key];

  const clientId = read("GOOGLE_CLIENT_ID");
  const clientSecret = read("GOOGLE_CLIENT_SECRET");
  const refreshToken = read("GOOGLE_REFRESH_TOKEN");
  const expectedEmail = read("GMAIL_ACCOUNT_EMAIL");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are required"
    );
  }

  const tokens = createAccessTokenSource({ clientId, clientSecret, refreshToken });
  const client = new GmailClient({ tokens });

  const profile = await client.getProfile();
  if (
    expectedEmail &&
    profile.emailAddress.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  ) {
    throw new Error(
      `Authorized mailbox ${profile.emailAddress} does not match GMAIL_ACCOUNT_EMAIL`
    );
  }

  const labels = await client.listLabels();
  const plan = buildMigrationPlan(labels);

  console.log(`Mailbox verified: ${profile.emailAddress}`);
  console.log(
    `Labels on account: ${labels.length} (user: ${labels.filter((l) => l.type !== "system").length})`
  );
  console.log(`Legacy mappings needing action: ${plan.legacyMappingsApplied}`);
  console.log("Plan:");
  for (const entry of plan.entries) {
    let detail = `create ${entry.targetName}`;
    if (entry.action === "rename") {
      detail = `rename ${entry.legacyName} -> ${entry.targetName}`;
    } else if (entry.action === "conflict") {
      detail = `conflict: keep ${entry.targetName}; alias ${entry.legacyName}`;
    } else if (entry.action === "reuse") {
      detail = `reuse ${entry.targetName}`;
    }
    console.log(`  ${entry.semanticKey}: ${detail}`);
  }
  console.log("Parent containers:");
  for (const container of plan.parentContainers) {
    console.log(`  ${container.name}: ${container.action}`);
  }
  if (plan.conflicts.length > 0) {
    console.log(
      `Conflicts requiring owner review: ${plan.conflicts.map((c) => c.semanticKey).join(", ")}`
    );
  }
  console.log("Read-only inventory complete; no Gmail changes were made.");
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`label-inventory failed: ${message}`);
  process.exit(1);
}
