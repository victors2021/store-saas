#!/usr/bin/env bash
set -euo pipefail
saas_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/medusa-saas-m2-verification}
mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
export SAAS_ARTIFACT_DIR="$artifact_dir"
cd "$saas_source"
# Includes the native mode-off build/integration suites and all M1 checks.
bash saas/verify-m1.sh > "$artifact_dir/m1-verification.log" 2>&1
(
  cd packages/core/utils
  env -u MEDUSA_SAAS_MODE node ../../../node_modules/jest/bin/jest.js --config ./jest.config.js --runInBand \
    --runTestsByPath src/dml/__tests__/tenant-scoped.spec.ts \
    --json --outputFile="$artifact_dir/m2-dml.json" > "$artifact_dir/m2-dml.log" 2>&1
)
SAAS_M2_TEST_RESET=1 SAAS_M2_RESULT="$artifact_dir/m2-http.json" XDG_CONFIG_HOME="$artifact_dir/config" \
  node --test saas/m2-http.test.cjs > "$artifact_dir/m2-http.log" 2>&1
echo "M2 verification completed; results in $artifact_dir"
