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

Live at `/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration and PKCE). Setup steps for users are on the `/connect` page.

- Done: search_flights, get_flight, find_places, search_hotels, find_rental_car (a Discover Cars link), my_trips, company_policy, set_work_trip, log_expense. Each search becomes a Chit trip chat, so the cards and bookings show in Chit. Pay links only. Per-account rate limit (20 calls a minute, 300 an hour) and an audit row per call (McpCall). Customers disconnect apps on /connect.
- Next:
  - Try it in Claude (Settings → Connectors → Add custom connector) and in ChatGPT developer mode on the live site.
  - ChatGPT app polish: widgets (flight and hotel cards rendered in ChatGPT), then submit to the app directory.
  - Submit to Claude's connector directory once it's stable.
  - Rental car search with Neon's live browser (needs a way to hand over the pay link outside the chat).

## Ideas parked

- Disruption help: on a flight delay, rebook if needed, move the car pick-up and tell the hotel.
- Price-drop watch on booked, changeable fares.
