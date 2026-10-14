# Chit roadmap

What's agreed but not built yet, roughly in order. Update it as things ship.

## Now: prove the live flows (test mode, no real money)

- Run the 🧪 trip chip end to end. Pay for the flight and hotel with Stripe's test card 4242 4242 4242 4242. Take the car to the Pay on Discover Cars link and stop there.
- Car: use the logged `dropdown:` markup to make Discover Cars' country of residence and date-of-birth dropdowns fill automatically. Match the real confirmation page in the booking-status check.
- Switch on Klarna, Affirm and Afterpay in the Stripe Dashboard (Settings → Payment methods). Try a test checkout.
- Hold a Duffel Airways fare in test mode, then pay it from the trip page.

## Next: hardening

- Keep the car-booking state (last search, results page, payment page) in the database, not process memory, so a redeploy mid-booking doesn't lose it.
- Store pages (header banner, footer) still say "personal POS system": update them to the Chit / Neon wording.
- Verify a sending domain in Resend so hotel and front-desk emails come from Chit.
- Decide fees (FLIGHT_FEE_PCT / HOTEL_FEE_PCT). They also decide how often pay-over-time is offered (lib/flex-pay.ts).
- Go-live checklist: Stripe, Duffel and LiteAPI live keys, and a last review of the refund, hold and cancellation paths.

## Company travel, phase 2

- Approval emails: a booking over policy goes to an approver, who approves or declines from the email. Neon waits, then books or offers the in-policy option.
- Admin spend dashboard: by person, trip, category and month, plus policy exceptions.
- Later: QuickBooks / Xero export, company-issued cards with budgets (Stripe Issuing, funded by the company), SSO.

## Chit MCP: a Claude and ChatGPT connector

Publish Chit as a remote MCP server, so other assistants can search and book through Chit. Claude takes remote MCP servers as custom connectors, and ChatGPT's apps and connectors are built on MCP, so one server serves both.

- Tools, built on the same code as Neon's connectors (not a second system):
  - search flights (with fare types)
  - search hotels
  - find a rental car (search and pick)
  - my trips (itinerary and receipts)
  - log an expense
  - the company travel policy
- Payment stays as pay links (Stripe Checkout, Pay on Discover Cars). The MCP never handles card data.
- Each user connects their Chit account with OAuth, so bookings, saved details and expenses go to the right person and company.
- Rate limits per account, no browser sessions exposed, and audit logs of bookings started through the MCP.
- Revenue is the same as in the app: flight and hotel fees plus the Discover Cars affiliate commission.
- Do it after the core flows are solid on the real sites. Estimate about a week.

## Ideas parked

- Disruption help: on a flight delay, rebook if needed, move the car pick-up and tell the hotel.
- Price-drop watch on booked, changeable fares.
