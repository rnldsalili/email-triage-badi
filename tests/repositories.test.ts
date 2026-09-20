import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/db/client";
import { reserveInferenceCall } from "../src/db/repositories/budget";
import {
  claimDueJobs,
  createGenerationJob,
  createInitialJob,
} from "../src/db/repositories/jobs";
import { acquireLease, releaseLease, renewLease } from "../src/db/repositories/leases";
import { enqueueOperation } from "../src/db/repositories/operations";
import { leases } from "../src/db/schema";

const ACCOUNT = "owner@example.test";

const db = () => createDb(env.DB);

describe("lease ownership", () => {
  it("allows only one owner until expiry, then a takeover", async () => {
    const client = db();
    const now = 1_000_000;
    const key = "mailbox:lease-test";

    const first = await acquireLease(client, key, "owner-a", now, 1000);
    expect(first.acquired).toBeTruthy();
    const contender = await acquireLease(client, key, "owner-b", now + 500, 1000);
    expect(contender.acquired).toBeFalsy();
    const takeover = await acquireLease(client, key, "owner-b", now + 1000, 1000);
    expect(takeover.acquired).toBeTruthy();
  });

  it("renews only for the current owner and not after expiry", async () => {
    const client = db();
    const now = 2_000_000;
    const key = "mailbox:renew-test";

    await acquireLease(client, key, "owner-a", now, 1000);
    await expect(
      renewLease(client, key, "owner-b", now + 100, 1000)
    ).resolves.toBeFalsy();
    await expect(
      renewLease(client, key, "owner-a", now + 100, 1000)
    ).resolves.toBeTruthy();
    await expect(
      renewLease(client, key, "owner-a", now + 2000, 1000)
    ).resolves.toBeFalsy();
  });

  it("releases only for the current owner", async () => {
    const client = db();
    const now = 3_000_000;
    const key = "mailbox:release-test";

    await acquireLease(client, key, "owner-a", now, 1000);
    await expect(releaseLease(client, key, "owner-b")).resolves.toBeFalsy();
    await expect(releaseLease(client, key, "owner-a")).resolves.toBeTruthy();
    const reacquired = await acquireLease(client, key, "owner-b", now + 1, 1000);
    expect(reacquired.acquired).toBeTruthy();
  });
});

describe("daily inference budget", () => {
  it("never exceeds the cap and starts a new day fresh", async () => {
    const client = db();
    const day = "2026-09-20";
    const now = 4_000_000;

    const firstReservation = await reserveInferenceCall(client, ACCOUNT, day, 2, now);
    expect(firstReservation.reserved).toBeTruthy();
    const secondReservation = await reserveInferenceCall(client, ACCOUNT, day, 2, now);
    expect(secondReservation.reserved).toBeTruthy();
    const third = await reserveInferenceCall(client, ACCOUNT, day, 2, now);
    expect(third.reserved).toBeFalsy();
    expect(third.used).toBe(2);

    const nextDay = await reserveInferenceCall(client, ACCOUNT, "2026-09-21", 2, now);
    expect(nextDay.reserved).toBeTruthy();
  });

  it("refuses every reservation when the cap is zero", async () => {
    const client = db();
    const result = await reserveInferenceCall(client, ACCOUNT, "2026-09-20", 0, 1);
    expect(result.reserved).toBeFalsy();
    expect(result.used).toBe(0);
  });
});

describe("job identity", () => {
  it("rejects duplicate initial jobs but allows new generations", async () => {
    const client = db();
    const now = 5_000_000;
    const accountId = "acct-job-identity";
    const messageId = "message-1";

    await expect(
      createInitialJob(client, {
        accountId,
        id: "job-1",
        messageId,
        now,
      })
    ).resolves.toBeTruthy();
    await expect(
      createInitialJob(client, {
        accountId,
        id: "job-2",
        messageId,
        now,
      })
    ).resolves.toBeFalsy();
    await expect(
      createGenerationJob(client, {
        accountId,
        generation: 2,
        id: "job-3",
        kind: "reprocess",
        messageId,
        now,
      })
    ).resolves.toBeTruthy();
    await expect(
      createGenerationJob(client, {
        accountId,
        generation: 2,
        id: "job-4",
        kind: "reprocess",
        messageId,
        now,
      })
    ).resolves.toBeFalsy();
  });

  it("claims due jobs once and respects the batch limit", async () => {
    const client = db();
    const now = 6_000_000;
    const accountId = "acct-job-claim";
    for await (const messageId of ["message-a", "message-b", "message-c"]) {
      await createInitialJob(client, {
        accountId,
        id: `job-${messageId}`,
        messageId,
        now,
      });
    }

    const first = await claimDueJobs(client, {
      accountId,
      leaseMs: 1000,
      limit: 2,
      now,
      ownerToken: "runner-1",
    });
    expect(first.map((job) => job.messageId).toSorted()).toStrictEqual([
      "message-a",
      "message-b",
    ]);

    const second = await claimDueJobs(client, {
      accountId,
      leaseMs: 1000,
      limit: 2,
      now: now + 1,
      ownerToken: "runner-2",
    });
    expect(second.map((job) => job.messageId)).toStrictEqual(["message-c"]);

    const third = await claimDueJobs(client, {
      accountId,
      leaseMs: 1000,
      limit: 5,
      now: now + 2,
      ownerToken: "runner-3",
    });
    expect(third).toStrictEqual([]);
  });
});

describe("operation coalescing", () => {
  it("coalesces queued optional-key operations and allows a new one later", async () => {
    const client = db();
    const now = 7_000_000;

    const first = await enqueueOperation(client, {
      accountId: ACCOUNT,
      coalesceKey: "sync",
      id: "op-1",
      kind: "sync",
      now,
      requestJson: "{}",
    });
    expect(first.created).toBeTruthy();

    const second = await enqueueOperation(client, {
      accountId: ACCOUNT,
      coalesceKey: "sync",
      id: "op-2",
      kind: "sync",
      now: now + 1,
      requestJson: "{}",
    });
    expect(second.created).toBeFalsy();
    expect(second.operation.id).toBe("op-1");

    await client.run(sql`UPDATE operations SET status = 'completed' WHERE id = 'op-1'`);

    const third = await enqueueOperation(client, {
      accountId: ACCOUNT,
      coalesceKey: "sync",
      id: "op-3",
      kind: "sync",
      now: now + 2,
      requestJson: "{}",
    });
    expect(third.created).toBeTruthy();
    expect(third.operation.id).toBe("op-3");
  });

  it("does not coalesce operations without a coalesce key", async () => {
    const client = db();
    const now = 8_000_000;
    const first = await enqueueOperation(client, {
      accountId: ACCOUNT,
      id: "op-a",
      kind: "backfill",
      now,
      requestJson: "{}",
    });
    const second = await enqueueOperation(client, {
      accountId: ACCOUNT,
      id: "op-b",
      kind: "backfill",
      now: now + 1,
      requestJson: "{}",
    });
    expect(first.created).toBeTruthy();
    expect(second.created).toBeTruthy();
  });
});

describe("D1 batch atomicity", () => {
  it("rolls back the whole batch when one statement fails", async () => {
    const client = db();
    const row = {
      acquiredAt: 1,
      expiresAt: 2,
      ownerToken: "owner",
      resourceKey: "batch-key",
      updatedAt: 1,
    };

    await expect(
      client.batch([
        client.insert(leases).values(row),
        client.insert(leases).values({ ...row, ownerToken: "owner-2" }),
      ])
    ).rejects.toThrow(/unique/iu);

    const rows = await client
      .select()
      .from(leases)
      .where(eq(leases.resourceKey, "batch-key"));
    expect(rows).toHaveLength(0);
  });
});
