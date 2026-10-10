#!/usr/bin/env bash
# Cloud Agent bootstrap for the persistent localhost SaaS preview (registerable).
# Creates private preview dir, marked Postgres DB, migrations, demo identities.
# Does NOT commit secrets. Not a production recipe.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd")
ENV_ROOT=${SAAS_ENV_ROOT:-/workspace/.store-saas-environment}
PREVIEW=${SAAS_PREVIEW_DIRECTORY:-/workspace/.store-saas-preview}
DB_NAME=${SAAS_PREVIEW_DB:-medusa_saas_preview}
DB_ROLE=${SAAS_PREVIEW_ROLE:-medusa_saas_preview_app}
MARKER='store-saas-persistent-local-development-v1'
BASE_DOMAIN=${SAAS_BASE_DOMAIN:-shops.example.test}
ADMIN_URL=${SAAS_ADMIN_DATABASE_URL:-postgres://postgres@127.0.0.1:5432/postgres}
MIG_URL=${SAAS_MIGRATION_DATABASE_URL:-postgres://postgres@127.0.0.1:5432/${DB_NAME}}
APP_URL=${SAAS_DATABASE_URL:-postgres://${DB_ROLE}@127.0.0.1:5432/${DB_NAME}}

mkdir -p "$ENV_ROOT/bin" "$ENV_ROOT/config"
if [[ ! -f "$ENV_ROOT/activate.sh" ]]; then
  cat > "$ENV_ROOT/bin/yarn" <<YARN
#!/bin/sh
exec node "$ROOT/.yarn/releases/yarn-3.2.1.cjs" "\$@"
YARN
  chmod +x "$ENV_ROOT/bin/yarn"
  cat > "$ENV_ROOT/activate.sh" <<ACT
export PATH=$ENV_ROOT/bin:\$PATH
export YARN_CACHE_FOLDER=${YARN_CACHE_FOLDER:-$ENV_ROOT/yarn-cache}
export YARN_CHECKSUM_BEHAVIOR=\${YARN_CHECKSUM_BEHAVIOR:-throw}
export YARN_NM_MODE=\${YARN_NM_MODE:-hardlinks-local}
export NODE_OPTIONS=\${NODE_OPTIONS:---max-old-space-size=4096}
export XDG_CONFIG_HOME=$ENV_ROOT/config
ACT
fi
# shellcheck disable=SC1091
source "$ENV_ROOT/activate.sh"
cd "$ROOT"

echo "==> ensuring PostgreSQL and Redis"
sudo service postgresql start || true
sudo service redis-server start || true
for i in $(seq 1 30); do
  if sudo -u postgres psql -Atc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
sudo -u postgres psql -Atc 'SELECT 1' >/dev/null
redis-cli ping | grep -q PONG

echo "==> ensuring marked preview database"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_ROLE}') THEN
    CREATE ROLE ${DB_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END\$\$;
SELECT 'role-ok';
SQL
if ! sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME} OWNER postgres"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "COMMENT ON DATABASE ${DB_NAME} IS '${MARKER}'"
fi
MARKER_NOW=$(sudo -u postgres psql -Atc "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='${DB_NAME}'")
if [[ "$MARKER_NOW" != "$MARKER" ]]; then
  echo "Preview DB marker mismatch: got '$MARKER_NOW'" >&2
  exit 1
fi

echo "==> private preview directory + runtime keyring"
install -d -m 700 "$PREVIEW" "$PREVIEW/objects"
if [[ ! -f "$PREVIEW/runtime.json" ]]; then
  umask 077
  node - <<'NODE' "$PREVIEW"
const fs=require("fs"),crypto=require("crypto"),path=process.argv[1]
const runtime={
  jwtSecret:crypto.randomBytes(48).toString("hex"),
  contextSecret:crypto.randomBytes(48).toString("hex"),
  namespaceSecret:crypto.randomBytes(48).toString("hex"),
  platformKey:crypto.randomBytes(48).toString("hex"),
  paymentKey:crypto.randomBytes(32).toString("hex"),
}
fs.writeFileSync(path+"/runtime.json", JSON.stringify(runtime,null,2)+"\n", {flag:"wx", mode:0o600})
NODE
fi
chmod 700 "$PREVIEW" 2>/dev/null || true
chmod 600 "$PREVIEW/runtime.json"

JWT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).jwtSecret)' "$PREVIEW/runtime.json")

echo "==> yarn install (if needed)"
if [[ ! -d "$ROOT/node_modules/@medusajs/framework" ]]; then
  yarn install --immutable --inline-builds
fi

echo "==> migrations (M5 + platform login + self-service)"
export SAAS_MIGRATION_DATABASE_URL="$MIG_URL"
export SAAS_APPLICATION_ROLE="$DB_ROLE"
export SAAS_JWT_SECRET="$JWT"
export SAAS_OBJECT_ROOT="$PREVIEW/objects"
export SAAS_BASE_DOMAIN="$BASE_DOMAIN"
export SAAS_ALLOW_NATIVE_REFERENCE_SEEDS=true
node saas/migrate-m5-command.cjs
psql "$MIG_URL" -c "GRANT CONNECT ON DATABASE ${DB_NAME} TO ${DB_ROLE};" >/dev/null || true

echo "==> platform operator + demo identities"
export SAAS_PLATFORM_ACTOR_ID=platform_admin
NODE_ENV=development node saas/provision-platform-operator.cjs || true
NODE_ENV=development SAAS_DEMO_DIRECTORY="$PREVIEW" node saas/provision-demo.cjs
# Optional ordinary platform admin password (demo platform admin already from provision-demo)
if [[ ! -f "$PREVIEW/platform-password.txt" ]]; then
  NODE_ENV=development SAAS_PLATFORM_ACTOR_ID=platform_admin \
    SAAS_PLATFORM_EMAIL="admin@${BASE_DOMAIN}" \
    SAAS_PLATFORM_PASSWORD_FILE="$PREVIEW/platform-password.txt" \
    node saas/provision-platform-login.cjs || true
fi

echo "==> builds (admin + storefront) if missing"
if [[ ! -f "$ROOT/saas/admin-dist/index.html" || ! -f "$ROOT/saas/storefront/.next/prerender-manifest.json" ]]; then
  yarn turbo run build --filter=integration-tests-http... --filter=@medusajs/payment-stripe... --concurrency=2 --no-daemon
  yarn workspace @medusajs/loyalty-plugin build:plugin || true
  # Next production build must not inherit NODE_ENV=development
  env -u NODE_ENV SAAS_ARTIFACT_DIR=/workspace/.store-saas-verification/setup bash saas/build-m3.sh
  if [[ ! -f "$ROOT/saas/storefront/.next/prerender-manifest.json" ]]; then
    (cd "$ROOT/saas/storefront" && rm -rf .next && \
      env -u NODE_ENV NODE_ENV=production MEDUSA_BACKEND_URL=http://127.0.0.1:9000 SAAS_BASE_DOMAIN="$BASE_DOMAIN" \
        node node_modules/next/dist/bin/next build)
  fi
fi

cat <<MSG
{"ok":true,"preview":"$PREVIEW","database":"$DB_NAME","register":"https://localhost:9443/register","start":"NODE_ENV=development SAAS_PREVIEW_DIRECTORY=$PREVIEW SAAS_CLOUD_LOCAL_BROWSE=1 node saas/start-demo-preview.cjs"}
MSG
