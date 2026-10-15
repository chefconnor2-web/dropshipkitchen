import Link from "next/link";
import { config } from "@/lib/config";

export const metadata = { title: "Refund policy" };

// The refund policy in plain words. Every promise here is what the code does: failed bookings are refunded in
// full automatically, cancellations return exactly what the airline or hotel refunds (shown before you confirm),
// and our service fee is kept on cancellations. Airline-initiated cancellations are handled by a person (for now).
export default function RefundsPage() {
  const s = config.storeName;
  const email = config.email.storeEmail;
  return (
    <div className="wrap page narrow refunds">
      <h1 className="page-title">Refund policy</h1>
      <p className="muted small">Last updated October 15, 2026</p>
      <p>
        Short version: <b>if we can&rsquo;t book what you paid for, you get every cent back, automatically.</b> If you cancel, you get back what the airline or hotel refunds, and we show you that
        amount before you confirm. The refund rules for every fare and room are shown before you pay, next to the Pay button and in your confirmation email.
      </p>

      <h2>Flights</h2>
      <ul>
        <li>
          <b>We couldn&rsquo;t book it</b> (the fare sold out, the airline raised the price, or the airline refused): full refund of everything you paid, including our fee, issued automatically and
          emailed to you.
        </li>
        <li>
          <b>You cancel a refundable fare:</b> from your trip page (or ask Neon), you see exactly what the airline will refund before you confirm. That amount goes back to your card as soon as the
          airline confirms. {s}&rsquo;s service fee, included in the price you paid, isn&rsquo;t refunded.
        </li>
        <li>
          <b>Fares that refund as airline credit:</b> the credit stays with you at the airline for a future flight; there&rsquo;s no card refund.
        </li>
        <li>
          <b>Non-refundable fares</b> (marked &ldquo;No refund&rdquo; before you pay): nothing is refunded if you cancel. Fares whose refund rules the airline doesn&rsquo;t state are treated as
          non-refundable, and we say so before you pay.
        </li>
        <li>
          <b>The airline cancels or majorly changes your flight:</b> you&rsquo;re entitled to a refund under the airline&rsquo;s rules. Contact us and we&rsquo;ll process it within one business day.
        </li>
        <li>
          <b>Held fares:</b> holding is free. If you don&rsquo;t pay before the deadline, the airline releases the seats and nothing is charged.
        </li>
      </ul>

      <h2>Hotels</h2>
      <ul>
        <li>
          <b>We couldn&rsquo;t book it:</b> full refund of everything you paid, including our fee, automatically.
        </li>
        <li>
          <b>Free-cancellation rooms:</b> cancel online from your booking page before the deadline shown when you booked, and the room price comes back to your card. {s}&rsquo;s service fee isn&rsquo;t
          refunded.
        </li>
        <li>
          <b>After the deadline, or non-refundable rooms</b> (marked before you pay): nothing is refunded if you cancel.
        </li>
        <li>
          <b>Taxes the hotel collects at check-in</b> are paid to the hotel and handled under its rules.
        </li>
      </ul>

      <h2>Products</h2>
      <ul>
        <li>
          <b>If we can&rsquo;t fulfil your order</b> (out of stock, or the supplier&rsquo;s price changed): you get every cent back, automatically.
        </li>
        <li>
          <b>Shipping:</b> most products ship from overseas warehouses and take about 10&ndash;20 business days (the estimate is shown before you pay). Every parcel is tracked.
        </li>
        <li>
          <b>Lost or arrived damaged:</b> email us within 14 days of the expected delivery date (with a photo if it&rsquo;s damaged). We send a replacement, or refund you if a replacement isn&rsquo;t possible.
        </li>
        <li>
          <b>No change-of-mind returns.</b> Personalized items can&rsquo;t be returned, so check the preview before you order.
        </li>
        <li>
          <b>Import duties and taxes</b> charged by your country on delivery are paid by you.
        </li>
      </ul>

      <h2>Plans</h2>
      <ul>
        <li>Plans renew monthly until you cancel. Cancel any time in billing; you keep access until the end of the month you&rsquo;ve paid for.</li>
      </ul>

      <h2>How refunds work</h2>
      <ul>
        <li>We send refunds the moment they&rsquo;re due. Your bank usually shows them in 5&ndash;10 business days.</li>
        <li>Refunds go back to the card or payment method you paid with. Pay-later plans (Klarna, Affirm, Afterpay) are refunded through that provider.</li>
        <li>Every refund is confirmed by email.</li>
      </ul>

      <h2>Disputed payments</h2>
      <ul>
        <li>If you dispute a payment with your bank instead of contacting us, we may cancel the booking while the dispute is open. Your bank handles the money through the dispute, so nothing is refunded twice.</li>
        <li>We send the bank the booking details and these terms. Accounts with a disputed payment can&rsquo;t make new bookings.</li>
      </ul>

      <h2>Something wrong? Talk to us first</h2>
      <p>
        {email ? (
          <>
            Write to <a href={`mailto:${email}`}>{email}</a> or reply to any booking email.
          </>
        ) : (
          <>Reply to any booking email.</>
        )}{" "}
        We answer within one business day. Please contact us before disputing a charge with your bank: it&rsquo;s faster, and we&rsquo;ll make it right.
      </p>
      <p className="muted small">
        See also our <Link href="/terms">terms</Link> and <Link href="/privacy">privacy policy</Link>. Rental cars are booked and refunded directly by Discover Cars under their policy.
      </p>
    </div>
  );
}
