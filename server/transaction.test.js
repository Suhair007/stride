import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { isSerializationConflict, withSerializationRetry } from "./transaction.js";

function prismaError(code, meta) {
  return new Prisma.PrismaClientKnownRequestError("Transaction failed", {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta,
  });
}

test("recognizes Prisma and PostgreSQL serialization conflicts", () => {
  assert.equal(isSerializationConflict(prismaError("P2034")), true);
  assert.equal(isSerializationConflict(prismaError("P2010", { code: "40001" })), true);
  assert.equal(isSerializationConflict(prismaError("P2010", { code: "23505" })), false);
  assert.equal(isSerializationConflict(new Error("network disconnected")), false);
});

test("retries a transient serialization conflict and returns the successful result", async () => {
  let attempts = 0;
  const result = await withSerializationRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw prismaError("P2010", { code: "40001" });
    return "saved";
  }, { baseDelayMs: 0 });

  assert.equal(result, "saved");
  assert.equal(attempts, 2);
});

test("stops after the configured number of retries", async () => {
  let attempts = 0;
  await assert.rejects(
    withSerializationRetry(async () => {
      attempts += 1;
      throw prismaError("P2034");
    }, { maxRetries: 2, baseDelayMs: 0 }),
    (error) => error.code === "P2034",
  );
  assert.equal(attempts, 3);
});

test("does not retry unrelated database errors", async () => {
  let attempts = 0;
  await assert.rejects(
    withSerializationRetry(async () => {
      attempts += 1;
      throw prismaError("P2010", { code: "23505" });
    }, { baseDelayMs: 0 }),
    (error) => error.meta.code === "23505",
  );
  assert.equal(attempts, 1);
});
