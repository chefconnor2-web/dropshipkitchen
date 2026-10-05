import Link from "next/link";
import { config, storeInitials } from "@/lib/config";
import TrackForm from "./TrackForm";

export const metadata = { title: `Track your order — ${config.storeName}` };

export default function TrackPage() {
  return (
    <div className="wrap page narrow trk">
      <p className="eyebrow">Order tracking</p>
      <h1 className="page-title">Where’s my order?</h1>
      <p className="trk-lead">Enter your order number and email. You’ll see every step, live from the carrier, with a link to track it on the carrier’s own site.</p>
      <TrackForm example={`${storeInitials()}-20261005-AB12C`} />
      <p className="muted small trk-help">
        Your order number is in your confirmation email. Signed in? Your orders are on <Link href="/account">your account</Link>.
      </p>
    </div>
  );
}
