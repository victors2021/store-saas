#!/usr/bin/env bash
set -euo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/medusa-saas-m3-verification}
mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
cd "$source_root"
node saas/check-baseline.cjs > "$artifact_dir/baseline-check.log" 2>&1
yarn turbo run build --filter=@medusajs/admin-vite-plugin... --filter=@medusajs/admin-sdk... --filter=@medusajs/admin-bundler... --filter=@medusajs/ui... --filter=@medusajs/js-sdk... --concurrency=3 --no-daemon > "$artifact_dir/admin-dependencies-build.log" 2>&1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/admin/dashboard/tsconfig.typecheck.json > "$artifact_dir/admin-typecheck.log" 2>&1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p saas/admin/tsconfig.typecheck.json > "$artifact_dir/admin-extension-typecheck.log" 2>&1
cd "$source_root/packages/admin/dashboard"
VITE_MEDUSA_BASE=/app VITE_MEDUSA_SAAS_MODE=true VITE_MEDUSA_PROJECT="$source_root/saas/admin" \
  node ../../../node_modules/vite/bin/vite.js build --outDir "$source_root/saas/admin-dist" --emptyOutDir > "$artifact_dir/admin-build.log" 2>&1
cd "$source_root/saas/storefront"
node .yarn/releases/yarn-4.12.0.cjs install --immutable > "$artifact_dir/storefront-install.log" 2>&1
node node_modules/typescript/bin/tsc --noEmit > "$artifact_dir/storefront-typecheck.log" 2>&1
MEDUSA_BACKEND_URL=http://127.0.0.1:9000 SAAS_BASE_DOMAIN=shops.example.test \
  node node_modules/next/dist/bin/next lint > "$artifact_dir/storefront-lint.log" 2>&1
MEDUSA_BACKEND_URL=http://127.0.0.1:9000 SAAS_BASE_DOMAIN=shops.example.test \
  node node_modules/next/dist/bin/next build > "$artifact_dir/storefront-build.log" 2>&1
printf 'M3 native Admin and storefront builds completed\n'
