import { BaerlyError } from "@gusto/baerly-storage";
export async function withRetry<T>(
  op: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (!(error instanceof BaerlyError) || !error.retriable || attempt === 3) {
        throw error;
      }
      await sleep(error.retryAfter !== undefined ? error.retryAfter * 1000 : 100);
    }
  }
}
export async function main() {
  return undefined;
}
