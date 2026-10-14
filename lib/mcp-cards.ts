// Cards for the Chit MCP's in-chat view (MCP Apps: Claude and ChatGPT render it next to the reply). Neon's
// cards (flights, hotels, cars, Amazon carts, emails…) and the Chit cart become one simple shape the view draws,
// with absolute links that open Chit's own booking and checkout pages in the customer's browser.

import { config } from "@/lib/config";
import { clock, dayShift, durationLabel, flightPrice, ruleLabel, stayPrice, stopsLabel, uberLink, type ConnectorItem } from "@/lib/flights-shared";

export interface ViewAction {
  label: string;
  url: string;
  primary?: boolean;
}

export interface ViewCard {
  kind: "flight" | "hotel" | "car" | "cart" | "amazon" | "email" | "supplier" | "browser" | "product" | "trip";
  id: string;
  title: string;
  subtitle?: string;
  lines: string[];
  badges?: string[];
  price?: string;
  priceNote?: string;
  /** Neon's live browser for this chat: the view streams it and lets the customer take over. */
  live?: { chatId: string; session: string; site?: string; runId?: string; stepId?: string; needs?: string };
  /** Fare types (Basic, Standard, Flex…): each one books its own offer. */
  options?: Array<{ label: string; price: string; detail: string; url: string }>;
  actions: ViewAction[];
}

const abs = (path: string) => (path.startsWith("http") ? path : `${config.siteUrl}${path}`);
const withChat = (path: string, chatId?: string) => abs(chatId ? `${path}?chat=${encodeURIComponent(chatId)}` : path);

/** Neon's cards as view cards. `chatId`: the trip chat their bookings file under. */
export function viewCards(items: ConnectorItem[], chatId?: string): ViewCard[] {
  return items.flatMap((it): ViewCard[] => {
    switch (it.kind) {
      case "flight": {
        const first = it.slices[0];
        const last = it.slices[it.slices.length - 1];
        const book = withChat(`/flights/book/${encodeURIComponent(it.id)}`, chatId);
        return [
          {
            kind: "flight",
            id: it.id,
            title: `${first.fromCity || first.from} → ${it.slices.length > 1 && last.to === first.from ? `${first.toCity || first.to} and back` : last.toCity || last.to}`,
            subtitle: [it.airline, it.cabin.replace(/_/g, " ") + (it.fareBrand ? ` · ${it.fareBrand}` : "")].join(" · "),
            lines: it.slices.map((s) => `${s.depart.slice(5, 10).replace("-", "/")} ${s.from} ${clock(s.depart)} → ${s.to} ${clock(s.arrive)}${dayShift(s.depart, s.arrive)} · ${durationLabel(s.durationMin)} · ${stopsLabel(s)}`),
            badges: [
              `${it.checkedBags} checked bag${it.checkedBags === 1 ? "" : "s"}`,
              ruleLabel(it.changeRule, "changes"),
              ruleLabel(it.refundRule, "refund"),
              it.holdable ? "Can hold" : null,
              it.group ?? null,
            ].filter((b): b is string => !!b),
            price: flightPrice(it),
            priceNote: it.slices.length > 1 ? "round trip, fees included" : "fees included",
            ...(it.fares && it.fares.length > 1
              ? {
                  options: it.fares.map((f) => ({
                    label: f.brand,
                    price: flightPrice({ priceCents: f.priceCents, currency: it.currency }),
                    detail: [`${f.checkedBags} bag${f.checkedBags === 1 ? "" : "s"}`, ruleLabel(f.changeRule, "changes"), ruleLabel(f.refundRule, "refund")].filter(Boolean).join(" · "),
                    url: withChat(`/flights/book/${encodeURIComponent(f.id)}`, chatId),
                  })),
                }
              : {}),
            actions: [{ label: "Book", url: book, primary: true }],
          },
        ];
      }
      case "hotel":
        return [
          {
            kind: "hotel",
            id: it.id,
            title: it.name,
            subtitle: [it.stars ? `${"★".repeat(Math.round(it.stars))}` : null, it.rating ? `${it.rating.toFixed(1)}/10` : null, it.address || it.city].filter(Boolean).join(" · "),
            lines: [`${it.checkin} → ${it.checkout} · ${it.nights} night${it.nights === 1 ? "" : "s"}`, [it.room, it.board].filter(Boolean).join(" · ")],
            badges: [it.refundable ? "Free cancellation" : it.refundable === false ? "Non-refundable" : null, it.group ?? null].filter((b): b is string => !!b),
            price: stayPrice(it),
            priceNote: `${stayPrice({ priceCents: Math.round(it.priceCents / Math.max(1, it.nights)), currency: it.currency })}/night, taxes included`,
            actions: [
              { label: "Book", url: withChat(`/hotels/book/${encodeURIComponent(it.id)}`, chatId), primary: true },
              ...(it.address ? [{ label: "Ride there", url: uberLink({ name: it.name, address: it.address, latitude: it.latitude, longitude: it.longitude }) }] : []),
            ],
          },
        ];
      case "car":
        return [
          {
            kind: "car",
            id: it.id,
            title: it.booked ? `Car booked · ${it.booked.supplier ?? it.location}` : `Rental car · ${it.location}`,
            subtitle: it.booked?.car ?? it.pick?.car,
            lines: [`${it.pickup} → ${it.dropoff}`, it.pick?.why ?? "", it.booked?.confirmation ? `Confirmation ${it.booked.confirmation}` : ""].filter(Boolean),
            price: it.booked?.price ?? it.pick?.price,
            actions: it.booked ? [] : [{ label: it.pay ? "Pay on Discover Cars" : it.filled ? "Continue on Discover Cars" : "Open Discover Cars", url: it.url, primary: true }],
          },
        ];
      case "cart-link":
        return [
          {
            kind: "amazon",
            id: it.id,
            title: `${it.site} cart`,
            subtitle: `${it.products} product${it.products === 1 ? "" : "s"}, ${it.units} item${it.units === 1 ? "" : "s"}`,
            lines: (it.items ?? []).slice(0, 8).map((i) => `${i.quantity} × ${i.title ?? i.asin}${i.delivery ? ` · ${i.delivery}` : ""}`),
            actions: [{ label: `Check out on ${it.site}`, url: it.url, primary: true }],
          },
        ];
      case "email-draft":
        return [
          {
            kind: "email",
            id: it.id,
            title: it.subject,
            subtitle: `To ${it.to}${it.from ? ` · from ${it.from}` : ""}`,
            lines: [it.body.slice(0, 280) + (it.body.length > 280 ? "…" : "")],
            badges: [it.status === "sent" ? "Sent" : it.status === "draft" ? "Draft: waiting for your approval" : "Not sent"],
            actions: [],
          },
        ];
      case "supplier":
        return [{ kind: "supplier", id: it.id, title: it.name, subtitle: it.location, lines: [it.offer, it.moq ? `MOQ ${it.moq}` : "", it.note ?? ""].filter(Boolean), price: it.price, actions: [{ label: "Contact", url: it.url, primary: true }] }];
      case "browser":
        return chatId ? [browserCard(chatId, it.session, it.site)] : [];
      default:
        return [];
    }
  });
}

/** Neon's live browser as a view card: the view streams it; "Open in Chit" is the fallback. */
export function browserCard(chatId: string, session: string, site?: string, step?: { runId: string; stepId: string; needs: string }): ViewCard {
  return {
    kind: "browser",
    id: `br_${session}`,
    title: `Neon's browser${site ? ` · ${site.replace(/^www\./, "")}` : ""}`,
    // The chat's "Approve & next" is the card's "I'm done" here.
    lines: step ? [step.needs.replace(/Approve & next/g, "I'm done")] : [],
    live: { chatId, session, site, ...(step ? { runId: step.runId, stepId: step.stepId, needs: step.needs } : {}) },
    actions: [{ label: "Open in Chit", url: abs(`/c/${chatId}`) }],
  };
}
