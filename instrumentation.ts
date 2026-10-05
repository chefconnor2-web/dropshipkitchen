// Runs once when the server process starts. Starts the background carrier-tracking poll (Node runtime only;
// the import sits inside the check so the edge bundle never includes it).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTrackingScheduler } = await import("@/lib/tracking");
    startTrackingScheduler();
  }
}
