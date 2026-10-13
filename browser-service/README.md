# Chit browser service

Live Chrome sessions for the Chit chat. Neon drives a browser on Amazon (search, add to cart, view cart) and the
shopper watches it live in the chat. Neon fills the cart as a guest and never signs in; at the end the shopper
gets one link that adds everything to their own Amazon cart in their own Safari or Amazon app. Only a robot
check (or a choice only they can make) opens this browser full screen on their phone; they finish and tap
**Done**, and Neon carries on. Neon never types passwords, codes, card numbers or addresses.

## Deploy (second Railway service in the same project)
- Source: this repo, root directory `browser-service` (it has its own `Dockerfile` and `railway.json`).
- Give it a public domain (the live view connects to it from shoppers' phones).
- Variables on this service:
  - `BROWSER_SERVICE_SECRET`: a long random string, the same value as on the Chit service.
  - `MAX_SESSIONS` (default 3): browsers at once, about 400–600 MB of RAM each.
  - `IDLE_MINUTES` (default 15): close a browser nobody has used for this long.
  - Optional: `SCREENCAST_QUALITY` (JPEG quality of the live view, default 60), `FRAME_QUEUE_BYTES` (per viewer,
    default 49152: no new frame is sent while a viewer's socket holds more), `ALLOWED_ORIGINS` (comma list of
    storefront origins allowed to open the live view, e.g. `https://storefront-preview-debc.up.railway.app`),
    `NAV_INTERCEPT=off` (turns off the page-load check described below), `UNWATCHED_MINUTES` (default 3: a
    browser nobody is watching and Neon isn't using closes after this, unless it's waiting on a robot check).
- Memory: each Amazon tab takes roughly 250–450 MB. With a 1 GB limit keep `MAX_SESSIONS` at 2 or raise the
  service's memory limit; Chrome is started with lighter settings and video/audio streams are blocked.
- Variables on the Chit (storefront) service:
  - `BROWSER_SERVICE_SECRET`: same value.
  - `BROWSER_SERVICE_URL`: private address, e.g. `http://chit-browser.railway.internal:8080`.
  - `BROWSER_PUBLIC_URL`: the public `https://…up.railway.app` address of this service.

## Safety
- Only Amazon pages can be opened (amazon.com, amazon.ca and Amazon's sign-in and payment hosts). Every page and
  frame load is checked before it's requested: the main page must be Amazon, and no frame loads from a private
  address. Internal names (`*.internal`, `*.railway.internal`, `localhost`) never resolve. Images, scripts and
  Amazon's own background requests aren't intercepted (that slowed Amazon down and broke add-to-cart), so a
  private IP address written into a subresource of an Amazon page isn't blocked by this service.
- The agent API needs `x-browser-secret`. The live view needs a token the storefront mints for the chat's owner
  (HMAC of the session id and an expiry, valid 10 minutes); it's never stored in the chat.
- One viewer at a time has control; input from anyone else is refused. Input runs one step at a time in order and
  each step is acknowledged; a step that fails is reported and never retried.
- The agent is locked out while the shopper has control. Nothing typed into the browser is logged.
- Browsers are incognito contexts and are destroyed when idle, so sign-ins don't persist.

## Live view protocol
See `docs/frontier-port/CONTRACTS.md` §8 in the repo root.

## Local test
`BROWSER_SERVICE_SECRET=dev CHROME_PATH=/path/to/chromium node server.mjs`

`CHROME_PATH=/path/to/chromium npm test` runs the transport tests (a real Chromium against a local page) and the
frame-delivery unit tests.
