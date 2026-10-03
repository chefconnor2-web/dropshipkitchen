#!/bin/sh
# Container entrypoint: create/upgrade the schema, sync the catalog when its version changes, start the server.
set -e
npx prisma db push --skip-generate

# Bump CATALOG when the seed targets change. The import runs in the background so the site comes up
# at once; --replace hides the previous catalog only after the new one imported.
CATALOG="offgrid-1"
MARKER=/data/catalog-version
if [ -n "$CJ_API_KEY" ] && [ "$(cat "$MARKER" 2>/dev/null)" != "$CATALOG" ]; then
  echo "Catalog $CATALOG not imported yet: importing from CJ in the background"
  (npm run seed:cj -- --publish --replace --limit 12 > /data/seed.log 2>&1 && echo "$CATALOG" > "$MARKER") &
fi

exec npx next start -p "${PORT:-3000}"
