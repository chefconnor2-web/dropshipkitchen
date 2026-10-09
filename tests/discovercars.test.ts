// Rental cars: the affiliate link and the model's search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverCarsUrl, parseCarSearch } from "../lib/connectors/discovercars";

test("the link carries our affiliate id", () => {
  process.env.DISCOVERCARS_AFFILIATE_ID = "chefconnor";
  assert.equal(discoverCarsUrl(), "https://www.discovercars.com/?a_aid=chefconnor");
  delete process.env.DISCOVERCARS_AFFILIATE_ID;
});

test("parseCarSearch checks the place and dates", () => {
  assert.deepEqual(parseCarSearch({ location: " Vancouver Airport (YVR) ", pickup_date: "2030-05-01", dropoff_date: "2030-05-04" }, "2030-01-01"), { location: "Vancouver Airport (YVR)", pickup: "2030-05-01", dropoff: "2030-05-04" });
  assert.match(String(parseCarSearch({ location: "", pickup_date: "2030-05-01", dropoff_date: "2030-05-04" }, "2030-01-01")), /city or airport/);
  assert.match(String(parseCarSearch({ location: "YVR", pickup_date: "2030-05-04", dropoff_date: "2030-05-01" }, "2030-01-01")), /on or after/);
});
