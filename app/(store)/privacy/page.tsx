import { config } from "@/lib/config";

export const metadata = { title: "Privacy" };

/** Privacy policy (also the one the Claude and ChatGPT connector listings link to). Draft: have it reviewed. */
export default function PrivacyPage() {
  const s = config.storeName;
  return (
    <div className="wrap page narrow">
      <h1 className="page-title">Privacy</h1>
      <p className="muted small">Last updated October 14, 2026</p>
      <h2>What we collect</h2>
      <ul>
        <li>Your account: email, and the name and phone number you give us.</li>
        <li>Your saved traveller details, if you save them (name, birth date, passport, address). Passport details are encrypted at rest.</li>
        <li>Your chats with Neon, searches, bookings, orders, cart and work expenses.</li>
        <li>Payments are handled by Stripe. We never see or store your card number.</li>
      </ul>
      <h2>How we use it</h2>
      <ul>
        <li>To search, book and buy what you ask for: we share what each booking needs with the airline (through Duffel), the hotel (through LiteAPI), the rental site you choose, and our product supplier.</li>
        <li>To run Neon: your messages are processed by Anthropic’s Claude models to answer you.</li>
        <li>To send booking confirmations and the emails you approve.</li>
        <li>For company travel: your company’s admins and approvers see the work trips and expenses you file with it.</li>
      </ul>
      <h2>Connected apps (Claude, ChatGPT)</h2>
      <ul>
        <li>When you connect {s} to another assistant, you choose full or read-only access. That app can then use {s}’s tools for you: search, see your trips, cart and chats, and (with full access) book or change things. Payment always happens on {s}’s or Stripe’s page in your own browser.</li>
        <li>What the app does with the results is covered by that app’s own privacy policy.</li>
        <li>We log each action a connected app takes (shown on your Connect page). Disconnect any app there at any time.</li>
      </ul>
      <h2>Your choices</h2>
      <ul>
        <li>Delete your saved details any time in My details. To delete your account and its data, email us from your account’s address.</li>
        <li>We don’t sell your data.</li>
      </ul>
    </div>
  );
}
