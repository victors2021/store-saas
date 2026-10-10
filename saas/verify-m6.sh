#!/usr/bin/env bash
set -euo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/store-saas-m6-verification}
mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
export SAAS_ARTIFACT_DIR="$artifact_dir"
cd "$source_root"
# Builders must finish before fixtures: native builds replace dist directories.
# Previous phase evidence is retained; every local fixture has its own marker.
bash saas/verify-m5.sh > "$artifact_dir/m0-m5-regression.log" 2>&1
SAAS_PLATFORM_LOGIN_TEST_RESET=1 SAAS_PLATFORM_LOGIN_RESULT="$artifact_dir/platform-login.json" node --test saas/platform-login.test.cjs > "$artifact_dir/platform-login.log" 2>&1
SAAS_SELF_SERVICE_TEST_RESET=1 SAAS_SELF_SERVICE_RESULT="$artifact_dir/self-service.json" node --test saas/self-service.test.cjs > "$artifact_dir/self-service.log" 2>&1
SAAS_SELF_SERVICE_BROWSER_RESET=1 SAAS_SELF_SERVICE_EVIDENCE_DIR="$artifact_dir/self-service-browser" python saas/self-service-browser.test.py > "$artifact_dir/self-service-browser.log" 2>&1
SAAS_M6_SECURITY_RESET=1 SAAS_M6_SECURITY_RESULT="$artifact_dir/m6-security.json" node --test saas/m6-security.test.cjs > "$artifact_dir/m6-security.log" 2>&1
SAAS_M6_TRANSACTION_RESET=1 SAAS_M6_TRANSACTION_RESULT="$artifact_dir/m6-transactions.json" node --test saas/m6-transactions.test.cjs > "$artifact_dir/m6-transactions.log" 2>&1
SAAS_M6_DEPLOYMENT_RESET=1 SAAS_M6_DEPLOYMENT_RESULT="$artifact_dir/m6-deployment.json" node --test saas/m6-deployment.test.cjs > "$artifact_dir/m6-deployment.log" 2>&1
SAAS_M6_GATE_RESULT="$artifact_dir/m6-release-gate.json" node --test saas/m6-release-gate.test.cjs > "$artifact_dir/m6-release-gate.log" 2>&1
node saas/m6-supply-chain.cjs "$artifact_dir/supply-chain" > "$artifact_dir/m6-supply-chain.log" 2>&1
# Reference run takes 30 minutes plus seeding/draining and separate checkout.
# --quick is only a smoke profile and cannot meet the PRD reference gate.
SAAS_M6_PERF_RESET=1 node saas/m6-performance.cjs > "$artifact_dir/m6-performance.log" 2>&1
printf 'M6 independent local development verification completed; external release gates are separate\n'
