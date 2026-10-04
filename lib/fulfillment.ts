// Placing orders with CJ. Every call here can create a real CJ order, so it is gated by SUPPLIER_MODE:
//   mock    (default) nothing is ever sent to CJ; approval records a mock reference
//   sandbox CJ sandbox orders only: simulated payment, no charge, no shipment
//   live    sandbox orders, and real orders paid from the CJ balance when the merchant confirms
// A real order is always three explicit steps: quote shipping → create the order → pay it.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { priceToCents } from "@/lib/money";
import { ORDER_STATUS } from "@/lib/orders";
import { sendOrderEmail } from "@/lib/order-emails";
import { choosePlan, parcelOptions, planParcels, planWindow, type ParcelPlanEntry } from "@/lib/parcels";

/** The pseudo shipping method for orders that ship as several CJ parcels. */
export const SPLIT_METHOD = "SPLIT";
import { CjApiError, createOrderV3, freightCalculate, getBalance, confirmOrder, getOrderDetail, payBalance, payBalanceV2, sandboxSimulatePay, type CjFreightOption } from "@/lib/cj/client";

export type SupplierMode = "mock" | "sandbox" | "live";

export function supplierMode(): SupplierMode {
  const m = config.supplierMode;
  return m === "live" || m === "sandbox" ? m : "mock";
}

export interface ShippingAddress {
  name?: string | null;
  phone?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
}

/** Where to ship from: the US warehouse when it can cover every item for a US address, else China (CJ's default). */
export function chooseFromCountry(items: Array<{ quantity: number; inventoryJson: string | null }>, destCountry?: string | null): string {
  if (destCountry && destCountry !== "US") return "CN";
  const usCovers = items.every((i) => {
    try {
      const rows = JSON.parse(i.inventoryJson || "[]") as Array<{ countryCode?: string; totalInventoryNum?: number; storageNum?: number }>;
      const us = rows.filter((r) => r.countryCode === "US").reduce((n, r) => n + (r.totalInventoryNum ?? r.storageNum ?? 0), 0);
      return us >= i.quantity;
    } catch {
      return false;
    }
  });
  return items.length > 0 && usCovers ? "US" : "CN";
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The createOrderV3 body for one store order. Throws a readable error when the address can't ship. */
export function buildCjOrderBody(input: {
  orderNumber: string;
  email: string | null;
  customerName: string | null;
  phone: string | null;
  ship: ShippingAddress | null;
  logisticName: string;
  fromCountryCode: string;
  sandbox: boolean;
  items: Array<{ vid: string; quantity: number; lineItemId: string }>;
}) {
  const a = input.ship?.address ?? {};
  const missing = (["line1", "city", "state", "country"] as const).filter((k) => !a[k]);
  if (missing.length) throw new Error(`The shipping address is missing: ${missing.join(", ")}.`);
  const name = input.ship?.name || input.customerName;
  if (!name) throw new Error("The shipping address has no recipient name.");
  return {
    orderNumber: input.orderNumber,
    shippingCountryCode: a.country!,
    shippingCountry: countryName(a.country!),
    shippingProvince: a.state!,
    shippingCity: a.city!,
    shippingAddress: a.line1!,
    shippingAddress2: a.line2 || "",
    shippingZip: a.postal_code || "",
    shippingCustomerName: name,
    shippingPhone: input.phone || input.ship?.phone || "",
    email: input.email || "",
    logisticName: input.logisticName,
    fromCountryCode: input.fromCountryCode,
    isSandbox: input.sandbox ? 1 : 0,
    products: input.items.map((i) => ({ vid: i.vid, quantity: i.quantity, storeLineItemId: i.lineItemId })),
  };
}

async function loadOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  const svs = await prisma.cjSupplierVariant.findMany({
    where: { cjVariantId: { in: order.items.map((i) => i.supplierVariantId) } },
    select: { cjVariantId: true, inventoryJson: true },
  });
  const inv = new Map(svs.map((s) => [s.cjVariantId, s.inventoryJson]));
  const ship = order.shippingAddressJson ? (JSON.parse(order.shippingAddressJson) as ShippingAddress) : null;
  const fromCountry = chooseFromCountry(
    order.items.map((i) => ({ quantity: i.quantity, inventoryJson: inv.get(i.supplierVariantId) ?? null })),
    ship?.address?.country,
  );
  return { order, fromCountry, ship };
}

/** Live CJ shipping options for this order's exact VIDs and address, cheapest first. Stored on the order. */
export async function quoteShipping(orderId: string): Promise<CjFreightOption[]> {
  if (supplierMode() === "mock") throw new Error("Set SUPPLIER_MODE to sandbox or live to quote CJ shipping.");
  const { order, fromCountry, ship } = await loadOrder(orderId);
  const country = ship?.address?.country;
  if (!country) throw new Error("This order has no shipping country yet.");
  const env = await freightCalculate({
    startCountryCode: fromCountry,
    endCountryCode: country,
    zip: ship?.address?.postal_code ?? undefined,
    products: order.items.map((i) => ({ vid: i.supplierVariantId, quantity: i.quantity })),
  });
  const options = (env.data ?? [])
    .filter((o) => o.logisticName)
    .map((o) => ({ logisticName: o.logisticName, logisticPrice: Number(o.logisticPrice), logisticAging: o.logisticAging }))
    .sort((a, b) => a.logisticPrice - b.logisticPrice);
  if (!options.length) {
    // Too heavy for one parcel: plan a split shipment, keeping the customer's methods where CJ still offers them.
    const items = order.items.map((i) => ({ vid: i.supplierVariantId, quantity: i.quantity }));
    const planned = await planParcels(items, fromCountry, country, ship?.address?.postal_code ?? undefined);
    if (!planned) throw new Error(`CJ has no shipping method from ${fromCountry} to ${country} for these items, even split into parcels.`);
    const paid = JSON.parse(order.parcelPlanJson || "[]") as ParcelPlanEntry[];
    const plan = choosePlan(planned).map((e, i) => {
      const want = paid[i]?.method;
      const o = want ? planned[i].options.find((x) => x.method === want) : undefined;
      return o ? { ...e, method: o.method, cents: o.cents } : e;
    });
    const w = planWindow(planned, plan);
    const split = [{ logisticName: SPLIT_METHOD, logisticPrice: plan.reduce((n, e) => n + e.cents, 0) / 100, logisticAging: w.minDays != null ? `${w.minDays}-${w.maxDays}` : "" }];
    await prisma.order.update({
      where: { id: order.id },
      data: { cjQuoteJson: JSON.stringify(split), parcelPlanJson: JSON.stringify(plan), cjFromCountry: fromCountry, cjError: null },
    });
    return split as CjFreightOption[];
  }
  await prisma.order.update({ where: { id: order.id }, data: { cjQuoteJson: JSON.stringify(options), cjFromCountry: fromCountry, cjError: null } });
  return options;
}

/**
 * Creates the CJ order (unpaid), then pays it from the CJ balance. `sandbox` orders never charge.
 * The status moves AWAITING_MERCHANT_APPROVAL → PLACING_SUPPLIER_ORDER atomically first, so a
 * double click or a second admin can't place the same order twice.
 */
export async function placeCjOrder(orderId: string, opts: { logisticName: string; sandbox: boolean }) {
  const mode = supplierMode();
  if (mode === "mock") throw new Error("SUPPLIER_MODE is mock: CJ orders are switched off.");
  if (!opts.sandbox && mode !== "live") throw new Error("Real CJ orders need SUPPLIER_MODE=live. This environment allows sandbox orders only.");

  const { order, fromCountry, ship } = await loadOrder(orderId);
  const quote = JSON.parse(order.cjQuoteJson || "[]") as CjFreightOption[];
  if (!quote.some((q) => q.logisticName === opts.logisticName)) throw new Error("Get a fresh shipping quote and choose one of its methods.");
  if (opts.logisticName === SPLIT_METHOD) return placeSplitCjOrder(orderId, opts.sandbox);

  const body = buildCjOrderBody({
    // A sandbox attempt gets its own number so a later real order for the same store order isn't a duplicate at CJ.
    orderNumber: opts.sandbox ? `${order.number}-SBX-${Date.now().toString(36).toUpperCase()}` : order.number,
    email: order.email,
    customerName: order.customerName,
    phone: order.customerPhone,
    ship,
    logisticName: opts.logisticName,
    fromCountryCode: order.cjFromCountry || fromCountry,
    sandbox: opts.sandbox,
    items: order.items.map((i) => ({ vid: i.supplierVariantId, quantity: i.quantity, lineItemId: i.id })),
  });

  const locked = await prisma.order.updateMany({
    where: { id: order.id, status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL, cjOrderId: null },
    data: { status: ORDER_STATUS.PLACING_SUPPLIER_ORDER, cjError: null },
  });
  if (locked.count === 0) throw new Error("This order is no longer awaiting approval, or a CJ order already exists for it.");

  let created;
  try {
    created = await createOrderV3(body);
  } catch (e) {
    const message = e instanceof CjApiError ? `CJ refused the order: ${e.message}` : String(e instanceof Error ? e.message : e);
    await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL, cjError: message } });
    throw new Error(message);
  }

  const d = created.data ?? {};
  const intercepted = (d.interceptOrderReasons ?? []).map((r) => r.message).filter(Boolean);
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: ORDER_STATUS.SUPPLIER_ORDER_PLACED,
      decidedAt: new Date(),
      cjSandbox: opts.sandbox,
      cjLogisticName: opts.logisticName,
      cjOrderNumber: body.orderNumber,
      cjOrderId: d.orderId ?? null,
      cjShipmentOrderId: d.shipmentOrderId ?? null,
      cjAmountCents: orderAmountCents(d),
      cjStatus: d.orderStatus ?? null,
      cjPlacedAt: new Date(),
      cjRawJson: JSON.stringify(d),
      cjError: intercepted.length ? `CJ flagged the order: ${intercepted.join("; ")}` : null,
      decisionNote: opts.sandbox
        ? "Approved with a CJ SANDBOX order: simulated payment, nothing is charged or shipped."
        : "Approved. A real CJ order was created.",
    },
  });
  // Payment is its own step so a failure leaves a created-but-unpaid order the admin can retry.
  return payCjOrder(order.id);
}

/** CJ's total for an order: its stated amount, else products + postage (createOrderV3 often leaves the total null). */
export function orderAmountCents(d: { orderAmount?: unknown; actualPayment?: unknown; productAmount?: unknown; postageAmount?: unknown }): number | null {
  const total = priceToCents(d.orderAmount) ?? priceToCents(d.actualPayment);
  if (total != null) return total;
  const products = priceToCents(d.productAmount);
  const postage = priceToCents(d.postageAmount);
  return products == null && postage == null ? null : (products ?? 0) + (postage ?? 0);
}

/** Pays a created CJ order from the CJ balance (sandbox orders use CJ's simulated payment). */
export async function payCjOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.cjPaidAt) return order;
  if (order.cjLogisticName === SPLIT_METHOD) return paySplitCjOrder(orderId);
  if (!order.cjShipmentOrderId && !order.cjOrderId) throw new Error("CJ returned no order id to pay. Check the order in your CJ dashboard.");
  if (!order.cjSandbox && supplierMode() !== "live") throw new Error("Paying a real CJ order needs SUPPLIER_MODE=live.");
  try {
    // CJ only accepts payment once the order is confirmed (CREATED → UNPAID).
    if (order.cjOrderId) {
      const detail = (await getOrderDetail(order.cjOrderId)).data ?? {};
      if (detail.orderStatus === "CREATED") await confirmOrder(order.cjOrderId);
    }
    // Sandbox orders take CJ's simulated payment. Real ones are paid from the balance: a single order by
    // its order id, a parent order (several sub-orders) by its shipment order id.
    if (order.cjSandbox) await sandboxSimulatePay(order.cjOrderId!);
    else if (order.cjShipmentOrderId) await payBalanceV2(order.cjShipmentOrderId);
    else await payBalance(order.cjOrderId!);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const message = order.cjSandbox
      ? `The CJ sandbox order was created but its simulated payment failed: ${reason}.`
      : `The CJ order was created but payment failed: ${reason}. Check your CJ balance, then retry payment.`;
    await prisma.order.update({ where: { id: orderId }, data: { cjError: message } });
    throw new Error(message);
  }
  return prisma.order.update({ where: { id: orderId }, data: { cjPaidAt: new Date(), cjError: null } });
}

/** Re-reads CJ's status and tracking number for a placed order. */
export async function refreshCjOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.cjLogisticName === SPLIT_METHOD) return refreshSplitCjOrder(orderId);
  if (!order.cjOrderId) throw new Error("No CJ order id on this order yet.");
  const d = (await getOrderDetail(order.cjOrderId)).data ?? {};
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      cjStatus: typeof d.orderStatus === "string" ? d.orderStatus : order.cjStatus,
      cjTrackingNumber: typeof d.trackNumber === "string" && d.trackNumber ? d.trackNumber : order.cjTrackingNumber,
      cjAmountCents: orderAmountCents(d as Parameters<typeof orderAmountCents>[0]) ?? order.cjAmountCents,
      cjRawJson: JSON.stringify(d),
    },
  });
  // First time CJ reports a tracking number: tell the customer.
  if (updated.cjTrackingNumber && !order.cjTrackingNumber) await sendOrderEmail(order.id, "order_shipped");
  return updated;
}

/** CJ balance in cents, or null when it can't be read (shown, never relied on). */
export async function cjBalanceCents(): Promise<number | null> {
  try {
    return priceToCents((await getBalance()).data?.amount);
  } catch {
    return null;
  }
}

// ---------- split shipments: one CJ order per parcel ----------

async function placeSplitCjOrder(orderId: string, sandbox: boolean) {
  const { order, fromCountry, ship } = await loadOrder(orderId);
  const plan = JSON.parse(order.parcelPlanJson || "[]") as ParcelPlanEntry[];
  if (!plan.length) throw new Error("This order has no parcel plan. Refresh the shipping quote.");
  // Each CJ line points back at our order line; a line can span several parcels.
  const lineFor = new Map(order.items.map((i) => [i.supplierVariantId, i.id]));

  const locked = await prisma.order.updateMany({
    where: { id: order.id, status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL, cjOrderId: null },
    data: { status: ORDER_STATUS.PLACING_SUPPLIER_ORDER, cjError: null },
  });
  if (locked.count === 0) throw new Error("This order is no longer awaiting approval, or CJ orders already exist for it.");

  const tag = sandbox ? `-SBX${Date.now().toString(36).toUpperCase()}` : "";
  const errors: string[] = [];
  let placed = 0;
  for (const [i, parcel] of plan.entries()) {
    const existing = await prisma.orderParcel.findUnique({ where: { orderId_index: { orderId: order.id, index: i } } });
    if (existing?.cjOrderId) {
      placed++;
      continue;
    }
    // The planned method may have gone; fall back to the cheapest CJ offers for this parcel now.
    let method = parcel.method;
    const now = await parcelOptions(order.cjFromCountry || fromCountry, ship?.address?.country ?? "", ship?.address?.postal_code ?? undefined, parcel.items).catch(() => []);
    if (now.length && !now.some((o) => o.method === method)) method = now[0].method;
    const body = buildCjOrderBody({
      orderNumber: `${order.number}-P${i + 1}${tag}`,
      email: order.email,
      customerName: order.customerName,
      phone: order.customerPhone,
      ship,
      logisticName: method,
      fromCountryCode: order.cjFromCountry || fromCountry,
      sandbox,
      items: parcel.items.map((x) => ({ vid: x.vid, quantity: x.quantity, lineItemId: `${lineFor.get(x.vid) ?? x.vid}-P${i + 1}` })),
    });
    const row = { orderId: order.id, index: i, itemsJson: JSON.stringify(parcel.items), logisticName: method, quotedCents: parcel.cents, cjOrderNumber: body.orderNumber };
    try {
      const d = (await createOrderV3(body)).data ?? {};
      await prisma.orderParcel.upsert({
        where: { orderId_index: { orderId: order.id, index: i } },
        create: { ...row, cjOrderId: d.orderId ?? null, cjShipmentOrderId: d.shipmentOrderId ?? null, cjAmountCents: orderAmountCents(d), cjStatus: d.orderStatus ?? null },
        update: { ...row, cjOrderId: d.orderId ?? null, cjShipmentOrderId: d.shipmentOrderId ?? null, cjAmountCents: orderAmountCents(d), cjStatus: d.orderStatus ?? null, cjError: null },
      });
      placed++;
    } catch (e) {
      const message = e instanceof CjApiError ? `CJ refused parcel ${i + 1}: ${e.message}` : String(e instanceof Error ? e.message : e);
      errors.push(message);
      await prisma.orderParcel.upsert({ where: { orderId_index: { orderId: order.id, index: i } }, create: { ...row, cjError: message }, update: { cjError: message } });
    }
  }

  const parcels = await prisma.orderParcel.findMany({ where: { orderId: order.id }, orderBy: { index: "asc" } });
  if (placed === 0) {
    await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL, cjError: errors.join(" ") } });
    throw new Error(errors.join(" "));
  }
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: ORDER_STATUS.SUPPLIER_ORDER_PLACED,
      decidedAt: new Date(),
      cjSandbox: sandbox,
      cjLogisticName: SPLIT_METHOD,
      cjOrderNumber: `${order.number} (${plan.length} parcels)`,
      cjOrderId: parcels.find((p) => p.cjOrderId)?.cjOrderId ?? null,
      cjAmountCents: parcels.reduce((n, p) => n + (p.cjAmountCents ?? 0), 0) || null,
      cjPlacedAt: new Date(),
      cjError: errors.length ? `${placed}/${plan.length} parcels placed. ${errors.join(" ")}` : null,
      decisionNote: sandbox
        ? `Approved with ${placed} CJ SANDBOX parcel orders: simulated payment, nothing is charged or shipped.`
        : `Approved. ${placed} real CJ parcel orders were created.`,
    },
  });
  return paySplitCjOrder(order.id);
}

async function paySplitCjOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!order.cjSandbox && supplierMode() !== "live") throw new Error("Paying real CJ orders needs SUPPLIER_MODE=live.");
  const parcels = await prisma.orderParcel.findMany({ where: { orderId, cjOrderId: { not: null }, cjPaidAt: null }, orderBy: { index: "asc" } });
  const errors: string[] = [];
  for (const p of parcels) {
    try {
      const detail = (await getOrderDetail(p.cjOrderId!)).data ?? {};
      if (detail.orderStatus === "CREATED") await confirmOrder(p.cjOrderId!);
      if (order.cjSandbox) await sandboxSimulatePay(p.cjOrderId!);
      else if (p.cjShipmentOrderId) await payBalanceV2(p.cjShipmentOrderId);
      else await payBalance(p.cjOrderId!);
      await prisma.orderParcel.update({ where: { id: p.id }, data: { cjPaidAt: new Date(), cjError: null } });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errors.push(`Parcel ${p.index + 1}: ${reason}`);
      await prisma.orderParcel.update({ where: { id: p.id }, data: { cjError: `Payment failed: ${reason}` } });
    }
  }
  const unpaid = await prisma.orderParcel.count({ where: { orderId, cjPaidAt: null } });
  if (errors.length || unpaid) {
    const message = `${errors.length ? errors.join(" ") + " " : ""}${unpaid} parcel order(s) still unpaid. Check your CJ balance, then retry payment.`;
    await prisma.order.update({ where: { id: orderId }, data: { cjError: message } });
    throw new Error(message);
  }
  return prisma.order.update({ where: { id: orderId }, data: { cjPaidAt: new Date(), cjError: null } });
}

async function refreshSplitCjOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const parcels = await prisma.orderParcel.findMany({ where: { orderId, cjOrderId: { not: null } }, orderBy: { index: "asc" } });
  for (const p of parcels) {
    const d = (await getOrderDetail(p.cjOrderId!)).data ?? {};
    await prisma.orderParcel.update({
      where: { id: p.id },
      data: {
        cjStatus: typeof d.orderStatus === "string" ? d.orderStatus : p.cjStatus,
        cjTrackingNumber: typeof d.trackNumber === "string" && d.trackNumber ? d.trackNumber : p.cjTrackingNumber,
        cjAmountCents: orderAmountCents(d as Parameters<typeof orderAmountCents>[0]) ?? p.cjAmountCents,
      },
    });
  }
  const fresh = await prisma.orderParcel.findMany({ where: { orderId }, orderBy: { index: "asc" } });
  const tracking = fresh.map((p) => p.cjTrackingNumber).filter(Boolean).join(", ") || null;
  const statuses = [...new Set(fresh.map((p) => p.cjStatus).filter(Boolean))];
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      cjTrackingNumber: tracking,
      cjStatus: statuses.length === 1 ? statuses[0] : statuses.join(" / ") || order.cjStatus,
      cjAmountCents: fresh.reduce((n, p) => n + (p.cjAmountCents ?? 0), 0) || order.cjAmountCents,
    },
  });
  if (updated.cjTrackingNumber && !order.cjTrackingNumber) await sendOrderEmail(order.id, "order_shipped");
  return updated;
}
