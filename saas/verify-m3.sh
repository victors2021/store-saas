#!/usr/bin/env bash
set -euo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/medusa-saas-m3-verification}
mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
export SAAS_ARTIFACT_DIR="$artifact_dir"
export XDG_CONFIG_HOME="$artifact_dir/config"
mkdir -p "$XDG_CONFIG_HOME"
cd "$source_root"
bash saas/start-services.sh > "$artifact_dir/services.log" 2>&1
bash saas/build-m3.sh
SAAS_M1_TEST_RESET=1 SAAS_M1_RESULT="$artifact_dir/m1-http-regression.json" node --test saas/m1-http.test.cjs > "$artifact_dir/m1-http-regression.log" 2>&1
SAAS_M2_TEST_RESET=1 SAAS_M2_RESULT="$artifact_dir/m2-http-regression.json" node --test saas/m2-http.test.cjs > "$artifact_dir/m2-http-regression.log" 2>&1
SAAS_M3_TEST_RESET=1 SAAS_M3_RESULT="$artifact_dir/m3-http.json" node --test saas/m3-http.test.cjs > "$artifact_dir/m3-http.log" 2>&1
SAAS_M3_TEST_RESET=1 SAAS_M3_LAUNCHER_RESULT="$artifact_dir/m3-launcher.json" node --test saas/m3-launcher.test.cjs > "$artifact_dir/m3-launcher.log" 2>&1
SAAS_M3_TEST_RESET=1 SAAS_M3_EVIDENCE_DIR="$artifact_dir" python -u saas/m3-browser.test.py > "$artifact_dir/m3-browser.log" 2>&1
printf 'M3 verification completed\n'
