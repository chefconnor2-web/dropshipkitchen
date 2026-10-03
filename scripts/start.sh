#!/bin/sh
# Container entrypoint: create/upgrade the schema, import the catalog on first boot, start the server.
set -e
npx prisma db push --skip-generate

# First boot only: an empty store imports real CJ products in the background so the site comes up at once.
if [ -n "$CJ_API_KEY" ] && [ "$(npx tsx scripts/product-count.ts)" = "0" ]; then
  echo "No products yet: importing the CJ catalog in the background"
  npm run seed:cj -- --publish --limit 12 > /data/seed.log 2>&1 &
fi

exec npx next start -p "${PORT:-3000}"
