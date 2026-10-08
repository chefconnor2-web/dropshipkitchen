// Share links for the major social networks. Each one opens that network's own "post this" page with the
// link and a line of text filled in; nothing is posted until the shopper confirms there. Instagram, TikTok
// and Snapchat have no web share page, so they're reached through the phone's share sheet (navigator.share).
// Shared only by the browser and tests, so nothing here may import server code.

export type ShareNetwork =
  | "whatsapp"
  | "facebook"
  | "messenger"
  | "x"
  | "threads"
  | "bluesky"
  | "linkedin"
  | "reddit"
  | "pinterest"
  | "telegram"
  | "sms"
  | "email";

export interface ShareTarget {
  id: ShareNetwork;
  label: string;
  /** Brand colour for the chip. */
  color: string;
  href: string;
  /** Only works on phones (opens an app, not a web page). */
  mobileOnly?: boolean;
}

/** The link as shared on one network, tagged so orders can be traced back to where the share came from. */
export function taggedUrl(url: string, source: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", source);
    u.searchParams.set("utm_medium", "social");
    u.searchParams.set("utm_campaign", "share");
    return u.toString();
  } catch {
    return url;
  }
}

export function shareTargets(url: string, text: string, image?: string | null): ShareTarget[] {
  const e = encodeURIComponent;
  const u = (source: string) => e(taggedUrl(url, source));
  const both = (source: string) => e(`${text} ${taggedUrl(url, source)}`);
  return [
    { id: "whatsapp", label: "WhatsApp", color: "#25D366", href: `https://wa.me/?text=${both("whatsapp")}` },
    { id: "facebook", label: "Facebook", color: "#1877F2", href: `https://www.facebook.com/sharer/sharer.php?u=${u("facebook")}` },
    { id: "messenger", label: "Messenger", color: "#0084FF", href: `fb-messenger://share/?link=${u("messenger")}`, mobileOnly: true },
    { id: "x", label: "X", color: "#000000", href: `https://x.com/intent/post?text=${e(text)}&url=${u("x")}` },
    { id: "threads", label: "Threads", color: "#101010", href: `https://www.threads.net/intent/post?text=${both("threads")}` },
    { id: "bluesky", label: "Bluesky", color: "#1185FE", href: `https://bsky.app/intent/compose?text=${both("bluesky")}` },
    { id: "linkedin", label: "LinkedIn", color: "#0A66C2", href: `https://www.linkedin.com/sharing/share-offsite/?url=${u("linkedin")}` },
    { id: "reddit", label: "Reddit", color: "#FF4500", href: `https://www.reddit.com/submit?url=${u("reddit")}&title=${e(text)}` },
    {
      id: "pinterest",
      label: "Pinterest",
      color: "#E60023",
      href: `https://www.pinterest.com/pin/create/button/?url=${u("pinterest")}&description=${e(text)}${image ? `&media=${e(image)}` : ""}`,
    },
    { id: "telegram", label: "Telegram", color: "#26A5E4", href: `https://t.me/share/url?url=${u("telegram")}&text=${e(text)}` },
    // "?&body=" works on both iPhone and Android.
    { id: "sms", label: "Text", color: "#34C759", href: `sms:?&body=${both("sms")}` },
    { id: "email", label: "Email", color: "#6B7280", href: `mailto:?subject=${e(text)}&body=${both("email")}` },
  ];
}
