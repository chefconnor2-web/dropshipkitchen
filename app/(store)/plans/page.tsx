import PlanPicker from "@/components/PlanPicker";
import { planOffer } from "@/lib/plan-offer";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: `Plans — ${config.storeName}` };

export default async function PlansPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <section className="band pp-page">
      <div className="wrap narrow">
        <p className="eyebrow">AI sourcing assistant</p>
        <h1 className="pp-title">Keep your sourcing assistant</h1>
        <p className="pp-lede">It finds the products, compares them and fills your cart. Pick how you want to keep going.</p>
        {error && <p className="notice err">{error}</p>}
        <PlanPicker offer={await planOffer()} />
      </div>
    </section>
  );
}
