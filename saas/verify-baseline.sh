#!/usr/bin/env bash
set -euo pipefail
saas_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/medusa-saas-verification}
mkdir -p "$artifact_dir"
export XDG_CONFIG_HOME="$artifact_dir/config"
mkdir -p "$XDG_CONFIG_HOME"
# This tested harness is for the disposable loopback services only.
export DB_HOST=localhost DB_USERNAME=postgres DB_PASSWORD='' DB_PORT=5432
export REDIS_URL=redis://localhost:6379
cd "$saas_source"
# Native integration tests emit a temporary ORM snapshot in the source tree.
# Remove only the known test output, and only if it did not exist before us.
generated_snapshots=()
for module in pricing product; do
  snapshot="$saas_source/packages/modules/$module/src/migrations/.snapshot-medusa-$module-integration-1.json"
  if [[ ! -e "$snapshot" ]]; then generated_snapshots+=("$snapshot"); fi
done
cleanup_snapshots() {
  for snapshot in "${generated_snapshots[@]}"; do rm -f -- "$snapshot"; done
}
trap cleanup_snapshots EXIT
bash saas/start-services.sh
yarn turbo run build --filter=integration-tests-http... --concurrency=3 --no-daemon > "$artifact_dir/build.log" 2>&1
yarn workspace @medusajs/loyalty-plugin build:plugin > "$artifact_dir/loyalty-build.log" 2>&1
node saas/check-baseline.cjs
node --test saas/tenant-context.test.cjs > "$artifact_dir/tenant-context.log" 2>&1
(
  cd packages/core/framework
  node ../../../node_modules/jest/bin/jest.js --config ./jest.config.js --runInBand \
    --runTestsByPath src/http/__tests__/validate-query.spec.ts src/http/utils/__tests__/get-query-config.spec.ts \
    --json --outputFile="$artifact_dir/framework.json" > "$artifact_dir/framework.log" 2>&1
)
(
  cd packages/modules/providers/auth-emailpass
  node ../../../../node_modules/jest/bin/jest.js --config ./jest.config.js --runInBand \
    --runTestsByPath integration-tests/__tests__/services.spec.ts \
    --json --outputFile="$artifact_dir/auth.json" > "$artifact_dir/auth.log" 2>&1
)
(
  cd packages/modules/pricing
  node ../../../node_modules/jest/bin/jest.js --config ./jest.config.js --runInBand \
    --runTestsByPath integration-tests/__tests__/services/pricing-module/calculate-price.spec.ts \
    --json --outputFile="$artifact_dir/pricing.json" > "$artifact_dir/pricing.log" 2>&1
)
(
  cd integration-tests/http
  node ../../node_modules/jest/bin/jest.js --config ./jest.config.js --runInBand --runTestsByPath \
    __tests__/cart/store/cart.spec.ts __tests__/payment/admin/payment.spec.ts \
    __tests__/order/admin/order.spec.ts __tests__/product/store/product.spec.ts \
    __tests__/customer/store/customer.spec.ts __tests__/order/store/order.spec.ts \
    __tests__/loyalty/store/orders.spec.ts \
    --json --outputFile="$artifact_dir/http.json" > "$artifact_dir/http.log" 2>&1
)
(
  cd packages/modules/product
  node ../../../node_modules/jest/bin/jest.js --config ./jest.config.js --runInBand \
    --runTestsByPath integration-tests/__tests__/product-module-service/product-variants.spec.ts \
    --json --outputFile="$artifact_dir/product-variants.json" > "$artifact_dir/product-variants.log" 2>&1
)
SAAS_PROBE_RESULT="$artifact_dir/native-catalog.json" node saas/native-catalog-probe.cjs --reset > "$artifact_dir/native-catalog.log" 2>&1
echo "Verification completed; results in $artifact_dir"
