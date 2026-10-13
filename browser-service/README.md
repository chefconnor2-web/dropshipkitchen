# Chit browser service

Live Chrome sessions for the Chit chat. Neon drives a browser on Amazon (search, add to cart, view cart) and the
shopper watches it live in the chat, and taps **Take over** to solve a captcha, sign in to their own Amazon
account and check out. Neon never types passwords, codes, card numbers or addresses.

## Deploy (second Railway service in the same project)
- Source: this repo, root directory `browser-service` (it has its own `Dockerfile` and `railway.json`).
- Give it a public domain (the live view connects to it from shoppers' phones).
- Variables on this service:
  - `BROWSER_SERVICE_SECRET`: a long random string, the same value as on the Chit service.
  - `MAX_SESSIONS` (default 3): browsers at once, about 400–600 MB of RAM each.
  - `IDLE_MINUTES` (default 15): close a browser nobody has used for this long.
- Variables on the Chit (storefront) service:
  - `BROWSER_SERVICE_SECRET`: same value.
  - `BROWSER_SERVICE_URL`: private address, e.g. `http://chit-browser.railway.internal:8080`.
  - `BROWSER_PUBLIC_URL`: the public `https://…up.railway.app` address of this service.

## Safety
- Only Amazon pages can be opened (amazon.com, amazon.ca and Amazon's sign-in and payment hosts). Private and
  internal addresses are blocked for every request.
- The agent API needs `x-browser-secret`; the live view needs a per-session token signed with the same secret.
- The agent is locked out while the shopper has control. Nothing typed into the browser is logged.
- Browsers are incognito contexts and are destroyed when idle, so sign-ins don't persist.

## Local test
`BROWSER_SERVICE_SECRET=dev CHROME_PATH=/path/to/chromium node server.mjs`
