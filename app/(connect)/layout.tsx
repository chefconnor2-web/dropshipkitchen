import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./connect.css";

// Connecting an AI app (Claude, ChatGPT…) to Chit: a full-screen page of its own, no store header, so the
// sign-in and the permission screen look like the product, not a shop page.
export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return <div className="cn">{children}</div>;
}
