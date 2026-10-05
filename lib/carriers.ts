// Tracking vocabulary with no database or CJ dependencies, shared by the sync job, emails and the order page.
// Stages, in order: label (shipped, waiting for the first carrier scan) → in_transit → out_for_delivery →
// delivered. "exception" (held, failed delivery, returning) can happen at any point and is shown honestly.

export const STAGES = ["label", "in_transit", "out_for_delivery", "delivered"] as const;
export type TrackingStage = (typeof STAGES)[number] | "exception";

const RANK: Record<TrackingStage, number> = { label: 0, in_transit: 1, out_for_delivery: 2, delivered: 3, exception: -1 };

/** CJ's (and the carrier's) free-text status, sorted into one of our stages. Unknown text means "label". */
export function stageOf(status: string | null | undefined): TrackingStage {
  const s = String(status ?? "").toLowerCase();
  if (!s) return "label";
  if (/out for delivery|with (the )?courier|on (the )?vehicle|delivering/.test(s)) return "out_for_delivery";
  if (/undeliver|not delivered|delivery (attempt|fail)|attempted|exception|fail|return|alert|expired|lost|damag|held|hold|refus|abnormal|problem/.test(s))
    return "exception";
  if (/deliver(ed)?\b|signed|picked up by (the )?(recipient|customer)|collected/.test(s)) return "delivered";
  if (/transit|picked up|accept|depart|arriv|dispatch|shipped|customs|sorting|facility|flight|on the way|in the way|processed|received by/.test(s))
    return "in_transit";
  return "label";
}

/** The stage of a whole order from its parcels: the least advanced one, or exception if any parcel has a problem. */
export function combinedStage(stages: TrackingStage[]): TrackingStage | null {
  if (!stages.length) return null;
  if (stages.includes("exception")) return "exception";
  return stages.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

export const STAGE_LABEL: Record<TrackingStage, string> = {
  label: "Shipped",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Needs attention",
};

// ---------- carrier links ----------

type CarrierRule = { match: RegExp; name: string; url: (n: string) => string };
const CARRIERS: CarrierRule[] = [
  { match: /canada ?post|postes? canada/i, name: "Canada Post", url: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}` },
  { match: /purolator/i, name: "Purolator", url: (n) => `https://www.purolator.com/en/shipping/tracker?pins=${n}` },
  { match: /usps|united states postal/i, name: "USPS", url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  { match: /\bups\b/i, name: "UPS", url: (n) => `https://www.ups.com/track?tracknum=${n}` },
  { match: /fedex/i, name: "FedEx", url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  { match: /dhl/i, name: "DHL", url: (n) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${n}` },
  { match: /royal ?mail/i, name: "Royal Mail", url: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}` },
  { match: /australia ?post|auspost/i, name: "Australia Post", url: (n) => `https://auspost.com.au/mypost/track/#/details/${n}` },
  { match: /nz ?post|new zealand post/i, name: "NZ Post", url: (n) => `https://www.nzpost.co.nz/tools/tracking?trackid=${n}` },
  { match: /deutsche post|dhl paket/i, name: "Deutsche Post", url: (n) => `https://www.deutschepost.de/sendung/simpleQuery.html?form.sendungsnummer=${n}` },
  { match: /la ?poste|colissimo/i, name: "La Poste", url: (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}` },
  { match: /postnl/i, name: "PostNL", url: (n) => `https://postnl.nl/tracktrace/?B=${n}` },
  { match: /\bgls\b/i, name: "GLS", url: (n) => `https://gls-group.com/track/${n}` },
  { match: /\bdpd\b/i, name: "DPD", url: (n) => `https://www.dpd.com/tracking/?parcelNumber=${n}` },
  { match: /evri|hermes/i, name: "Evri", url: (n) => `https://www.evri.com/track/parcel/${n}` },
  { match: /yanwen/i, name: "Yanwen", url: (n) => `https://track.yw56.com.cn/en/querydel?nums=${n}` },
];

export function universalTrackingUrl(n: string): string {
  return `https://t.17track.net/en#nums=${encodeURIComponent(n)}`;
}

export interface TrackingLink {
  label: string;
  href: string;
  number: string;
}

/**
 * Where a customer can check a parcel themselves: the delivering carrier's own site when we know it (that's
 * the source of truth people trust), plus a universal tracker for the international leg.
 */
export function trackingLinks(t: { number: string | null; lastMileCarrier?: string | null; lastMileNumber?: string | null }): TrackingLink[] {
  const links: TrackingLink[] = [];
  const lmNumber = t.lastMileNumber || t.number;
  const rule = t.lastMileCarrier ? CARRIERS.find((c) => c.match.test(t.lastMileCarrier!)) : undefined;
  if (rule && lmNumber) links.push({ label: `Track on ${rule.name}`, href: rule.url(encodeURIComponent(lmNumber)), number: lmNumber });
  else if (t.lastMileCarrier && t.lastMileNumber) links.push({ label: `Track with ${t.lastMileCarrier}`, href: universalTrackingUrl(t.lastMileNumber), number: t.lastMileNumber });
  if (t.number) links.push({ label: links.length ? "Full journey on 17TRACK" : "Track on 17TRACK", href: universalTrackingUrl(t.number), number: t.number });
  return links;
}
