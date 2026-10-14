// Offer terms that shut out a Canadian (or other non-US) resident renting in the US.
import { test } from "node:test";
import assert from "node:assert/strict";
import { excludesResident } from "../lib/connectors/discovercars";

const CA = { code: "CA", name: "Canada" };

test("flags offers for US residents only or needing a US licence", () => {
  assert.equal(excludesResident("Important: this offer is for US residents only.", CA), "US residents only");
  assert.match(excludesResident("A U.S. driver's license is required at pick-up.", CA) ?? "", /driver's license is required/);
  assert.match(excludesResident("Renters must hold a US driving licence.", CA) ?? "", /must hold a US driving licence/);
  assert.match(excludesResident("Not available to Canadian residents.", CA) ?? "", /Canadian residents/);
});

test("lets ordinary offers through, and never flags a US resident", () => {
  assert.equal(excludesResident("Full to full · Unlimited mileage · Free cancellation · Driver must be 25+", CA), null);
  assert.equal(excludesResident("International licences accepted with a passport.", CA), null);
  assert.equal(excludesResident("US residents only", { code: "US", name: "United States" }), null);
});
