#!/usr/bin/env bash
set -euo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/medusa-saas-m4-verification}
mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
export SAAS_ARTIFACT_DIR="$artifact_dir"
export XDG_CONFIG_HOME="$artifact_dir/config"
mkdir -p "$XDG_CONFIG_HOME"
cd "$source_root"
bash saas/start-services.sh > "$artifact_dir/services.log" 2>&1
yarn turbo run build --filter=integration-tests-http... --filter=@medusajs/payment-stripe... --concurrency=3 --no-daemon > "$artifact_dir/native-build.log" 2>&1
yarn workspace @medusajs/loyalty-plugin build:plugin > "$artifact_dir/loyalty-build.log" 2>&1
bash saas/build-m3.sh
(
  export DB_HOST=localhost DB_USERNAME=postgres DB_PASSWORD='' DB_PORT=5432 REDIS_URL=redis://localhost:6379
  unset MEDUSA_SAAS_MODE
  cd integration-tests/http
  node ../../node_modules/jest/bin/jest.js --config ./jest.config.js --runInBand --runTestsByPath \
    __tests__/payment/admin/payment.spec.ts __tests__/order/admin/order.spec.ts __tests__/order/admin/order-cancel-credit-line.spec.ts \
    --json --outputFile="$artifact_dir/native-mode-off.json" > "$artifact_dir/native-mode-off.log" 2>&1
)
node --test saas/tenant-context.test.cjs saas/auth-integration.test.cjs > "$artifact_dir/tenant-unit-regression.log" 2>&1
SAAS_M1_TEST_RESET=1 SAAS_M1_RESULT="$artifact_dir/m1-http-regression.json" node --test saas/m1-http.test.cjs > "$artifact_dir/m1-http-regression.log" 2>&1
SAAS_M2_TEST_RESET=1 SAAS_M2_RESULT="$artifact_dir/m2-http-regression.json" node --test saas/m2-http.test.cjs > "$artifact_dir/m2-http-regression.log" 2>&1
SAAS_M3_TEST_RESET=1 SAAS_M3_RESULT="$artifact_dir/m3-http-regression.json" node --test saas/m3-http.test.cjs > "$artifact_dir/m3-http-regression.log" 2>&1
SAAS_M3_TEST_RESET=1 SAAS_M3_LAUNCHER_RESULT="$artifact_dir/m3-launcher-regression.json" node --test saas/m3-launcher.test.cjs > "$artifact_dir/m3-launcher-regression.log" 2>&1
SAAS_M3_TEST_RESET=1 SAAS_M3_EVIDENCE_DIR="$artifact_dir" python -u saas/m3-browser.test.py > "$artifact_dir/m3-browser-regression.log" 2>&1
SAAS_M4_TEST_RESET=1 SAAS_M4_RESULT="$artifact_dir/m4-http.json" node --test saas/m4-http.test.cjs > "$artifact_dir/m4-http.log" 2>&1
SAAS_M4_TEST_RESET=1 SAAS_M4_LAUNCHER_RESULT="$artifact_dir/m4-launcher.json" node --test saas/m4-launcher.test.cjs > "$artifact_dir/m4-launcher.log" 2>&1
SAAS_M4_TEST_RESET=1 SAAS_M4_EVIDENCE_DIR="$artifact_dir" python -u saas/m4-browser.test.py > "$artifact_dir/m4-browser.log" 2>&1
printf 'M4 verification completed\n'
