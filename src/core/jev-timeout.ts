/** Bounds JEV decisions so an unavailable evaluator cannot hold a project queue indefinitely. */
export async function withJevTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("JEV evaluation timed out after 60 seconds. Re-evaluate the ticket to retry.")), 60_000);
  });
  try { return await Promise.race([run(), timeout]); }
  finally { clearTimeout(timer!); }
}
