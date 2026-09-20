import type { AppConfig } from "../config/env";
import type { Db } from "../db/client";
import {
  getMailbox,
  setMailboxAuthStatus,
  upsertMailbox,
} from "../db/repositories/mailboxes";
import type { Mailbox } from "../db/schema";
import type { GmailClient } from "../gmail/client";
import { GmailError } from "../gmail/errors";
import type { GmailProfile } from "../gmail/types";

export class MailboxIdentityError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super("Authorized Gmail account does not match the configured owner");
    this.name = "MailboxIdentityError";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface VerifiedMailbox {
  mailbox: Mailbox;
  profile: GmailProfile;
}

export const verifyMailboxIdentity = async (
  db: Db,
  client: GmailClient,
  config: AppConfig,
  now: number
): Promise<VerifiedMailbox> => {
  let profile: GmailProfile;
  try {
    profile = await client.getProfile();
  } catch (error) {
    if (
      error instanceof GmailError &&
      (error.reason === "auth_required" || error.reason === "auth_invalid")
    ) {
      const existing = await getMailbox(db);
      if (existing) {
        await setMailboxAuthStatus(db, existing.id, "auth_required", now);
      }
    }
    throw error;
  }

  if (
    profile.emailAddress.trim().toLowerCase() !==
    config.owner.accountEmail.trim().toLowerCase()
  ) {
    throw new MailboxIdentityError(config.owner.accountEmail, profile.emailAddress);
  }

  const mailbox = await upsertMailbox(db, {
    email: config.owner.accountEmail,
    id: crypto.randomUUID(),
    now,
  });
  await setMailboxAuthStatus(db, mailbox.id, "ok", now);

  return { mailbox: { ...mailbox, authStatus: "ok" }, profile };
};
