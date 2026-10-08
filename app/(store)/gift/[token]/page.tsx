// A gift's claim page: what it is, the merchant's note, and where to ship it. The link in the email is the
// only way in (the token is unguessable); nothing here is indexed.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { getShipTo } from "@/lib/cart";
import { SHIP_COUNTRIES } from "@/lib/countries";
import ClaimForm from "./ClaimForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your gift", robots: { index: false, follow: false } };

export default async function GiftPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const gift = await prisma.gift.findUnique({ where: { token } });
  if (!gift) notFound();
  const v = await prisma.productVariant.findUnique({ where: { id: gift.productVariantId }, include: { product: { include: { images: { take: 1, orderBy: { position: "asc" } } } } } });
  const item = v?.product.title ?? "gift";
  const photo = v?.imageUrl ? `/media/v/${v.id}` : v?.product.images[0] ? `/media/${v.product.images[0].id}` : null;
  const shipTo = await getShipTo();
  const first = gift.name?.split(" ")[0];
  return (
    <div className="wrap page narrow gift-page">
      <p className="eyebrow">A gift from {config.storeName}</p>
      <h1 className="page-title">{first ? `${first}, this one’s on us` : "This one’s on us"}</h1>
      <div className="gift-hero">
        {photo && <img src={photo} alt={item} className="gift-photo" />}
        <img src={`/pod/${gift.personalizationId}/preview`} alt={`The ${config.storeName} logo printed on it`} className="gift-art" />
      </div>
      <p className="gift-what">
        A free <strong>{item}</strong> with the {config.storeName} logo, shipped to you.
      </p>
      {gift.message && <blockquote className="gift-note">{gift.message}</blockquote>}
      {gift.status === "CANCELLED" ? (
        <p className="notice">This gift link isn’t active any more.</p>
      ) : gift.status === "CLAIMED" ? (
        <p className="notice ok">You’ve claimed this gift. We’ll email you tracking when it ships.</p>
      ) : (
        <ClaimForm token={gift.token} item={item} countries={SHIP_COUNTRIES} defaultCountry={SHIP_COUNTRIES.some((c) => c.code === shipTo.country) ? shipTo.country : "CA"} />
      )}
    </div>
  );
}
