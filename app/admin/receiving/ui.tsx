import { daysUntil, fmtDay } from "@/lib/receiving/dates";

export function ExpiryPill({ date }: { date: Date | null }) {
  if (!date) return <span className="pill pill-noexp">No expiry</span>;
  const d = daysUntil(date);
  const tone = d < 0 ? "expired" : d <= 2 ? "soon" : "fine";
  const when = d < 0 ? `expired ${-d}d ago` : d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d}d`;
  return (
    <span className={`pill pill-exp-${tone}`} title={fmtDay(date)}>
      {fmtDay(date)} · {when}
    </span>
  );
}
