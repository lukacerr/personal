#!/usr/bin/env sh
set -eu

find_adb() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb
    return
  fi

  for candidate in \
    "${ANDROID_HOME:-}/platform-tools/adb" \
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
    "$HOME/Android/Sdk/platform-tools/adb"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  printf '%s\n' 'adb not found; add Android platform-tools to PATH or set ANDROID_HOME' >&2
  exit 1
}

adb_bin="$(find_adb)"

bun -e '
  const expected = { application: "software.luka.personal", version: 1 };
  const response = await fetch("http://127.0.0.1:5173/.well-known/personal-app.json");
  const marker = await response.json();
  if (!response.ok || JSON.stringify(marker) !== JSON.stringify(expected)) {
    throw new Error("Personal dev server is not available on localhost:5173");
  }
'

if ! "$adb_bin" get-state >/dev/null 2>&1; then
  cat >&2 <<'EOF'
No Android device is connected through ADB.

USB is not required on Android 11+:
  1. Enable Developer options > Wireless debugging.
  2. Choose "Pair device with pairing code".
  3. Run: adb pair PHONE_IP:PAIRING_PORT
  4. Run: adb connect PHONE_IP:DEBUG_PORT
  5. Re-run: bun run native:android:connect
EOF
  exit 1
fi

"$adb_bin" reverse tcp:5173 tcp:5173
"$adb_bin" reverse tcp:8080 tcp:8080
"$adb_bin" shell am force-stop software.luka.personal
"$adb_bin" shell am start -n software.luka.personal/.MainActivity >/dev/null

printf '%s\n' 'Android is using Personal web/API from localhost.'
