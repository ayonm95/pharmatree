const RPC_RETRY_DELAYS = [250, 750, 1500];

export async function withRpcRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let errDetails = "";
      try {
        errDetails = JSON.stringify(error);
      } catch {
        // ignore cyclic serialization
      }
      const rateLimited =
        message.includes("Too Many Requests") ||
        message.includes("-32005") ||
        message.includes("429") ||
        message.includes("rate limit") ||
        message.includes("missing response for request") ||
        errDetails.includes("-32005") ||
        errDetails.includes("Too Many Requests");

      if (!rateLimited || attempt >= RPC_RETRY_DELAYS.length) {
        throw error;
      }
      await new Promise((resolve) => window.setTimeout(resolve, RPC_RETRY_DELAYS[attempt]));
    }
  }
}
