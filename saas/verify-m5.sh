#!/usr/bin/env bash
set -euo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${SAAS_ARTIFACT_DIR:-/tmp/medusa-saas-m5-verification}
mkdir -p "$artifact_dir"
artifact_dir=$(cd "$artifact_dir" && pwd)
export SAAS_ARTIFACT_DIR="$artifact_dir"
cd "$source_root"
# M4 verifier includes native mode-off, M1–M4 HTTP, production builds and browsers.
# Shared fixed disposable fixture databases run serially. No production resets.
bash saas/verify-m4.sh > "$artifact_dir/m0-m4-regression.log" 2>&1
SAAS_M5_TEST_RESET=1 SAAS_M5_RESULT="$artifact_dir/m5-http.json" node --test saas/m5-http.test.cjs > "$artifact_dir/m5-http.log" 2>&1
SAAS_M4_UPGRADE_TEST_RESET=1 SAAS_M5_UPGRADE_RESULT="$artifact_dir/m5-upgrade.json" node --test saas/m5-upgrade.test.cjs > "$artifact_dir/m5-upgrade.log" 2>&1
SAAS_M5_BACKUP_TEST_RESET=1 SAAS_M5_BACKUP_RESULT="$artifact_dir/m5-backup.json" node --test saas/m5-backup.test.cjs > "$artifact_dir/m5-backup.log" 2>&1
SAAS_M5_LAUNCHER_TEST_RESET=1 SAAS_M5_LAUNCHER_RESULT="$artifact_dir/m5-launcher.json" node --test saas/m5-launcher.test.cjs > "$artifact_dir/m5-launcher.log" 2>&1
SAAS_M5_BROWSER_TEST_RESET=1 SAAS_M5_EVIDENCE_DIR="$artifact_dir" python -u saas/m5-browser.test.py > "$artifact_dir/m5-browser.log" 2>&1
printf 'M5 verification completed\n'
