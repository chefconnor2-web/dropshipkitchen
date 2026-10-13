// Runs jobs over a fixed set of workers (browser tabs), each worker taking the next job as soon as it's free.
// Results keep the input order. A job that throws gets { error } instead of stopping the others.

export async function runPool(items, workers, job, onProgress = () => {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await job(items[i], w, i);
        } catch (e) {
          results[i] = { error: e?.message || "failed" };
        }
        done++;
        onProgress(done, items.length);
      }
    }),
  );
  return results;
}
