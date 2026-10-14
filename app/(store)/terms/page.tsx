import { config } from "@/lib/config";

export const metadata = { title: "Terms" };

/** Terms of use (also linked from the connector listings). Draft: have it reviewed. */
export default function TermsPage() {
  const s = config.storeName;
  return (
    <div className="wrap page narrow">
      <h1 className="page-title">Terms</h1>
      <p className="muted small">Last updated October 14, 2026</p>
      <ul>
        <li>{s} finds and books flights, hotels and products for you, and links you to rental car sites. Prices shown include our fee. Fares and rates can change until you pay; we re-check before charging.</li>
        <li>Flights and hotels are provided by the airline or hotel under their own rules (changes, refunds, baggage). Rental cars are booked directly with Discover Cars and the rental company.</li>
        <li>Neon and connected assistants can make mistakes. Check the details on the booking or checkout page before you pay.</li>
        <li>Connected apps act only with the access you grant, and cancellations need your confirmation. You’re responsible for what you ask them to do.</li>
        <li>Plans renew monthly until cancelled in billing. AI use beyond your plan’s allowance isn’t available until it refills or you upgrade.</li>
        <li>Don’t use {s} for anything unlawful or to resell bookings.</li>
      </ul>
    </div>
  );
}
