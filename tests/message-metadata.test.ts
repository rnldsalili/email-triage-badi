import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/db/client";
import { messages } from "../src/db/schema";
import { GmailError } from "../src/gmail/errors";
import {
  persistMessageMetadata,
  refreshMessageMetadata,
} from "../src/services/message-metadata";
import { resetDatabase } from "./helpers/db";
import { fakeGmail } from "./helpers/gmail-fake";

const NOW = 1_700_000_000_000;
const ACCOUNT = "owner@example.test";

const seedMessage = async (
  db: ReturnType<typeof createDb>,
  gmailId: string
): Promise<string> => {
  const id = `message-${gmailId}`;
  await db.insert(messages).values({
    accountId: ACCOUNT,
    firstSeenAt: NOW,
    gmailMessageId: gmailId,
    id,
    receivedAt: NOW,
    threadId: `thread-${gmailId}`,
  });
  return id;
};

const stored = async (db: ReturnType<typeof createDb>, id: string) => {
  const [row] = await db
    .select({
      metadataErrorCode: messages.metadataErrorCode,
      metadataFetchedAt: messages.metadataFetchedAt,
      metadataState: messages.metadataState,
      subject: messages.subject,
    })
    .from(messages)
    .where(eq(messages.id, id));
  return row;
};

const failingGmail = (reason: "not_found" | "permission_denied" | "quota_exceeded") =>
  fakeGmail({
    getMessage: () => {
      throw new GmailError(reason, `simulated ${reason}`);
    },
  }).client;

describe("metadata persistence freshness", () => {
  it("accepts newer observations and drops older ones", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const id = await seedMessage(db, "gm-fresh");

    await persistMessageMetadata(db, id, {
      errorCode: null,
      fetchedAt: NOW + 1000,
      from: "newer@example.test",
      state: "available",
      subject: "Newer subject",
    });
    await persistMessageMetadata(db, id, {
      errorCode: null,
      fetchedAt: NOW,
      from: "older@example.test",
      state: "available",
      subject: "Older subject",
    });

    await expect(stored(db, id)).resolves.toStrictEqual({
      metadataErrorCode: null,
      metadataFetchedAt: NOW + 1000,
      metadataState: "available",
      subject: "Newer subject",
    });
  });

  it("drops a same-millisecond write so the first observation wins", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const id = await seedMessage(db, "gm-tie");

    await persistMessageMetadata(db, id, {
      errorCode: null,
      fetchedAt: NOW,
      from: null,
      state: "available",
      subject: "First",
    });
    await persistMessageMetadata(db, id, {
      errorCode: null,
      fetchedAt: NOW,
      from: null,
      state: "unavailable",
      subject: null,
    });

    await expect(stored(db, id)).resolves.toMatchObject({
      metadataState: "available",
      subject: "First",
    });
  });

  it("writes the first observation for a row with no fetch timestamp", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const id = await seedMessage(db, "gm-first");

    await persistMessageMetadata(db, id, {
      errorCode: null,
      fetchedAt: NOW,
      from: null,
      state: "available",
      subject: "First observation",
    });

    await expect(stored(db, id)).resolves.toMatchObject({
      metadataFetchedAt: NOW,
      metadataState: "available",
      subject: "First observation",
    });
  });
});

describe("metadata refresh outcomes", () => {
  it("treats quota exhaustion as environmental and leaves the row pending", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const id = await seedMessage(db, "gm-quota");

    const result = await refreshMessageMetadata(
      db,
      failingGmail("quota_exceeded"),
      { gmailMessageId: "gm-quota", id },
      NOW
    );

    expect(result).toStrictEqual({ errorCode: "quota_exceeded", status: "retry_later" });
    await expect(stored(db, id)).resolves.toMatchObject({ metadataState: "missing" });
  });

  it("records a message that no longer exists as unavailable", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const id = await seedMessage(db, "gm-gone");

    const result = await refreshMessageMetadata(
      db,
      failingGmail("not_found"),
      { gmailMessageId: "gm-gone", id },
      NOW
    );

    expect(result).toMatchObject({ status: "unavailable" });
    await expect(stored(db, id)).resolves.toStrictEqual({
      metadataErrorCode: "not_found",
      metadataFetchedAt: NOW,
      metadataState: "unavailable",
      subject: null,
    });
  });

  it("records terminal failures with a redacted code", async () => {
    const db = createDb(env.DB);
    await resetDatabase(db);
    const id = await seedMessage(db, "gm-denied");

    const result = await refreshMessageMetadata(
      db,
      failingGmail("permission_denied"),
      { gmailMessageId: "gm-denied", id },
      NOW
    );

    expect(result).toMatchObject({ status: "error" });
    await expect(stored(db, id)).resolves.toStrictEqual({
      metadataErrorCode: "permission_denied",
      metadataFetchedAt: NOW,
      metadataState: "error",
      subject: null,
    });
  });
});
