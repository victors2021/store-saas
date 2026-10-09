#!/usr/bin/env bash
set -euo pipefail
saas_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/medusa-saas-m1-verification}
mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
export SAAS_ARTIFACT_DIR="$artifact_dir"
export XDG_CONFIG_HOME="$artifact_dir/config"
export DB_HOST=localhost DB_USERNAME=postgres DB_PASSWORD='' DB_PORT=5432
export REDIS_URL=redis://localhost:6379
cd "$saas_source"
# Standard native regression remains single-tenant and explicitly mode-off.
env -u MEDUSA_SAAS_MODE bash saas/verify-baseline.sh > "$artifact_dir/baseline.log" 2>&1
node saas/inventory-m1.cjs > "$artifact_dir/m1-inventory.log" 2>&1
node --test saas/auth-integration.test.cjs > "$artifact_dir/m1-auth-adapter.log" 2>&1
SAAS_CONTROL_TEST_RESET=1 node --test saas/tenant-control.test.cjs > "$artifact_dir/m1-tenant-control.log" 2>&1
SAAS_CATALOG_MIGRATION_RESULT="$artifact_dir/m1-catalog-migration.json" \
  node saas/catalog-migration-probe.cjs --reset > "$artifact_dir/m1-catalog-migration.log" 2>&1
SAAS_M1_TEST_RESET=1 SAAS_M1_RESULT="$artifact_dir/m1-http.json" \
  node --test saas/m1-http.test.cjs > "$artifact_dir/m1-http.log" 2>&1
echo "M1 verification completed; results in $artifact_dir"
