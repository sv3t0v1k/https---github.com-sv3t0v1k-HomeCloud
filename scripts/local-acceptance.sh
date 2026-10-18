#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 2

REPORT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/homecloud-local-acceptance.XXXXXX") || exit 2
trap 'rm -rf "$REPORT_DIR"' EXIT HUP INT TERM

run_step() {
  label=$1
  shift
  printf '\n==> %s\n' "$label"
  "$@"
  result=$?
  if [ "$result" -ne 0 ]; then
    printf '\nFAIL (%s): %s\n' "$result" "$label" >&2
    printf 'Локальная приёмка остановлена на первом сбое.\n' >&2
    exit "$result"
  fi
  printf 'PASS: %s\n' "$label"
}

check_prerequisites() {
  command -v python3 >/dev/null 2>&1 || { echo 'Нужен python3.' >&2; return 2; }
  command -v node >/dev/null 2>&1 || { echo 'Нужен node.' >&2; return 2; }
  command -v npm >/dev/null 2>&1 || { echo 'Нужен npm.' >&2; return 2; }
  [ -x backend/node_modules/.bin/jest ] || { echo 'Нет backend/node_modules; выполните npm ci в backend/.' >&2; return 2; }
  [ -x frontend/node_modules/.bin/vitest ] || { echo 'Нет frontend/node_modules; выполните npm ci в frontend/.' >&2; return 2; }
  [ -f backend/package-lock.json ] && [ -f frontend/package-lock.json ] || {
    echo 'Не найдены npm lock-файлы.' >&2
    return 2
  }
  printf 'Node %s; npm %s; Python %s\n' "$(node --version)" "$(npm --version)" "$(python3 --version 2>&1 | awk '{print $2}')"
}

run_python_security_tests() {
  for test_file in \
    scripts/ci/test-release.py \
    scripts/ci/test-provenance.py \
    scripts/ci/test-scan-evidence.py \
    scripts/ci/test-scan-policy.py \
    scripts/ci/test-environment-evidence.py \
    scripts/ci/test-runner-minimization.py \
    scripts/ci/test-gosu-disposition.py \
    scripts/ci/test-oci-scan-binding.py \
    scripts/ci/test-policy-coverage.py \
    scripts/ci/test-stage-cache-proof.py \
    scripts/ci/test-secret-findings.py \
    scripts/ci/test-install-npm.py
  do
    python3 "$test_file" || return $?
  done
}

run_npm_audit() {
  component=$1
  report="$REPORT_DIR/audit-$component.json"
  npm --prefix "$component" audit --json >"$report"
  result=$?
  if [ "$result" -gt 1 ]; then
    echo "npm audit не смог получить корректный ответ для $component (код $result)." >&2
    return "$result"
  fi
  python3 scripts/ci/audit-gate.py "$report"
}

run_backend_tests() {
  # PostgreSQL suites read only this explicit test variable. Drop it here so
  # this local command can never connect to an inherited database endpoint.
  if [ "$(uname -s)" = Darwin ]; then
    # This native filesystem suite explicitly requires Linux; CI runs it there.
    env -u HOMECLOUD_TEST_DATABASE_URL npm --prefix backend test -- --runInBand --json --outputFile="$REPORT_DIR/backend-tests.json" --testPathIgnorePatterns=src/uploads/secure-filesystem.spec.ts || return $?
  else
    env -u HOMECLOUD_TEST_DATABASE_URL npm --prefix backend test -- --runInBand --json --outputFile="$REPORT_DIR/backend-tests.json" || return $?
  fi
  node -e '
    const report = require(process.argv[1]);
    const suites = report.testResults;
    const postgres = suites.filter((suite) => suite.name.endsWith(".postgres.spec.ts"));
    const skipped = suites.filter((suite) => suite.status === "pending").length;
    const failed = suites.filter((suite) => suite.status === "failed").length;
    const passed = suites.filter((suite) => suite.status === "passed").length;
    console.log(`Сводка Jest: ${passed} passed, ${skipped} skipped, ${failed} failed; PostgreSQL suites: ${postgres.length} обнаружено, ${postgres.filter((suite) => suite.status === "passed").length} запущено и прошло.`);
    if (postgres.length && postgres.some((suite) => suite.status === "pending")) {
      console.log("Ограничение: PostgreSQL integration suites пропущены без отдельной disposable test DB; они остаются обязательными в CI.");
    }
    if (process.platform === "darwin") {
      console.log("Ограничение: Linux-only secure-filesystem suite пропущен на macOS; он остаётся обязательным в Linux CI.");
    }
  ' "$REPORT_DIR/backend-tests.json"
}

run_step 'Проверка локальных инструментов и установленных зависимостей' check_prerequisites
run_step 'Security/policy regression tests из CI' run_python_security_tests
run_step 'Backend unit tests (без подключения к БД)' run_backend_tests
run_step 'Backend lint' npm --prefix backend run lint
run_step 'Backend build и compiled file-type test' npm --prefix backend run test:file-type:compiled
run_step 'Backend dependency-security runtime test' node --test --test-timeout=10000 backend/test/dependency-security-runtime.cjs
run_step 'Frontend unit tests' npm --prefix frontend test
run_step 'Frontend lint' npm --prefix frontend run lint
run_step 'Frontend TypeScript check и production build' npm --prefix frontend run build
run_step 'Backend npm audit и действующий audit gate' run_npm_audit backend
run_step 'Frontend npm audit и действующий audit gate' run_npm_audit frontend

cat <<'EOF'

ИТОГ: все запущенные локальные проверки пройдены; ограничения перечислены выше.
PostgreSQL integration suites не запускались: команда намеренно удаляет HOMECLOUD_TEST_DATABASE_URL из окружения.
Сканирование истории Gitleaks, Trivy environment/image qualification и обязательный GitHub CI gate этой командой не подтверждаются.
EOF
