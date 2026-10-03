import { config } from "@/lib/config";
import RuntimeCalculator from "@/components/store/RuntimeCalculator";

export const metadata = {
  title: `Starlink Mini battery runtime calculator — ${config.storeName}`,
  description: "How many hours a 20V tool battery runs a Starlink Mini, by battery size and how you use it.",
};

export default function RuntimePage() {
  return (
    <section className="band band-dark band-page">
      <div className="wrap">
        <p className="eyebrow">Runtime calculator</p>
        <h1 className="section-title">How long will a battery run your Starlink Mini?</h1>
        <p className="section-lede">
          Pick a 20V MAX battery size, how many you’ll bring, and how you’ll use the connection. The math is shown, so you
          can check it.
        </p>
        <RuntimeCalculator />
      </div>
    </section>
  );
}
