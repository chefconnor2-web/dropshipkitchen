// Pure CJ order-building logic. Nothing here calls CJ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCjOrderBody, chooseFromCountry } from "../lib/fulfillment";

const ship = {
  name: "Sam Rivera",
  address: { line1: "12 Ridge Rd", line2: "Unit 4", city: "Bend", state: "OR", postal_code: "97701", country: "US" },
};

test("buildCjOrderBody maps a Stripe shipping address onto CJ's createOrderV3 fields", () => {
  const body = buildCjOrderBody({
    orderNumber: "T-20261003-ABCDE",
    email: "sam@example.com",
    customerName: "Sam R.",
    phone: "+15415550100",
    ship,
    logisticName: "USPS+",
    fromCountryCode: "US",
    sandbox: true,
    items: [{ vid: "VID-1", quantity: 2, lineItemId: "item-1" }],
  });
  assert.equal(body.shippingCountryCode, "US");
  assert.equal(body.shippingCountry, "United States");
  assert.equal(body.shippingProvince, "OR");
  assert.equal(body.shippingCity, "Bend");
  assert.equal(body.shippingAddress, "12 Ridge Rd");
  assert.equal(body.shippingAddress2, "Unit 4");
  assert.equal(body.shippingZip, "97701");
  assert.equal(body.shippingCustomerName, "Sam Rivera"); // the shipping name wins over the card name
  assert.equal(body.shippingPhone, "+15415550100");
  assert.equal(body.isSandbox, 1);
  assert.deepEqual(body.products, [{ vid: "VID-1", quantity: 2, storeLineItemId: "item-1" }]);
});

test("buildCjOrderBody refuses an address CJ can't ship to", () => {
  assert.throws(
    () =>
      buildCjOrderBody({
        orderNumber: "X", email: null, customerName: null, phone: null,
        ship: { name: "A", address: { line1: "1 St", country: "US" } },
        logisticName: "USPS+", fromCountryCode: "CN", sandbox: false, items: [],
      }),
    /missing: city, state/,
  );
});

test("chooseFromCountry ships from the US only when the US warehouse covers every item", () => {
  const us = JSON.stringify([{ countryCode: "CN", totalInventoryNum: 900 }, { countryCode: "US", totalInventoryNum: 5 }]);
  const cnOnly = JSON.stringify([{ countryCode: "CN", totalInventoryNum: 900 }]);
  assert.equal(chooseFromCountry([{ quantity: 2, inventoryJson: us }]), "US");
  assert.equal(chooseFromCountry([{ quantity: 6, inventoryJson: us }]), "CN");
  assert.equal(chooseFromCountry([{ quantity: 1, inventoryJson: us }, { quantity: 1, inventoryJson: cnOnly }]), "CN");
  assert.equal(chooseFromCountry([{ quantity: 1, inventoryJson: null }]), "CN");
});
