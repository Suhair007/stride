import { Prisma } from "@prisma/client";

export function isSerializationConflict(error) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2034"
    || (error.code === "P2010" && error.meta?.code === "40001");
}

export async function withSerializationRetry(operation, { maxRetries = 2, baseDelayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= maxRetries) throw error;
      const delayMs = baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
