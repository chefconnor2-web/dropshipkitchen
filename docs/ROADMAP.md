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

- Done: search_flights, get_flight, find_places, search_hotels, find_rental_car (a Discover Cars link), my_trips, company_policy, set_work_trip, log_expense; shopping (search_products, get_product, add_to_cart, view_cart, update_cart on the account's cart, shared with every signed-in browser); Neon (my_chats, read_chat, ask_neon with neon_status and approve_neon_step: everything Neon does, live browser included, on the customer's AI allowance). Flight, hotel, car, cart, trip and Neon results show as cards in the chat (MCP Apps view ui://chit/cards.html), including Neon's live browser: watch, Take over, type, and "I'm done" to let Neon carry on. Each search becomes a Chit trip chat, so the cards and bookings show in Chit. Pay links only. Per-account rate limit (40 calls a minute, 300 an hour) and an audit row per call (McpCall). Customers disconnect apps on /connect.
- Also done: one-tap pay links (book_flight / book_hotel with saved details, hold and pay held fares, checkout_cart, payment_status), bookings (get_booking, two-step cancel_flight / cancel_hotel, share_trip), orders and tracking, account (my_details, update_my_details, my_plan, subscribe, billing_portal), company admin (invite_member, edit_policy, expense_report), personalized products, open_chit (tabs for trips, cart, orders, chats; full screen), interactive cards (Book with my details, cart + / − / remove, share and cancel buttons), full vs read-only access on the consent page, daily caps, an activity log on /connect, and /privacy and /terms (drafts to review).
- Next:
  - Try it all in Claude and ChatGPT on the live site.
  - Have the privacy policy and terms reviewed, then submit to Claude's connector directory and ChatGPT's app directory (they need a logo, screenshots and a test account).

## Ideas parked

- Disruption help: on a flight delay, rebook if needed, move the car pick-up and tell the hotel.
- Price-drop watch on booked, changeable fares.
