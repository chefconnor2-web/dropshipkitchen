// Runs once when the server process starts. Starts the background carrier-tracking poll and marks unfinished
// assistant runs interrupted (Node runtime only; the imports sit inside the check so the edge bundle never
// includes them).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTrackingScheduler } = await import("@/lib/tracking");
    startTrackingScheduler();
    // Card disputes: pulled from Stripe every 15 minutes in case a webhook is missed, evidence sent when due.
    const { startDisputeScheduler } = await import("@/lib/disputes");
    startDisputeScheduler();
    // Runs that were active when the last process stopped can't continue: mark them interrupted.
    const { recoverInterruptedRuns } = await import("@/lib/runs");
    await recoverInterruptedRuns().catch((e) => console.error("[runs] recovery failed:", e));
  }
}
