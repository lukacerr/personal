#!/usr/bin/env sh
set -eu

# Wireless debugging hands out a new port every time it is toggled, so the port
# is the only thing that usually changes. Pass it as the first argument:
#
#   bun run native:android:connect 45537
#
# With no argument the script reuses an already connected device, or discovers
# the port over mDNS. Override the address with ANDROID_PHONE_IP when needed.
phone_ip="${ANDROID_PHONE_IP:-192.168.1.46}"
port="${1:-}"

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

usage() {
  cat >&2 <<EOF
No Android device is reachable through ADB.

USB is not required on Android 11+:
  1. Enable Developer options > Wireless debugging.
  2. Pair once with "Pair device with pairing code":
       adb pair $phone_ip:PAIRING_PORT
  3. Re-run with the port shown under "Wireless debugging":
       bun run native:android:connect PORT

The pairing port and the debugging port are different, and the debugging port
changes every time wireless debugging is toggled.
EOF
  exit 1
}

# Devices already handshaken, newest first, ignoring offline entries.
connected_serials() {
  "$adb_bin" devices | awk '$2 == "device" { print $1 }'
}

# Wireless debugging advertises its current port over mDNS.
discover_serial() {
  "$adb_bin" mdns services 2>/dev/null \
    | awk '$2 == "_adb-tls-connect._tcp" { print $3; exit }'
}

responds() {
  "$adb_bin" -s "$1" shell true >/dev/null 2>&1
}

# Candidates in order of preference. A given port is tried first, but a stale
# one does not abort the run: wireless debugging changes the port on every
# toggle, so an already working connection is a better answer than an error.
resolve_serial() {
  if [ -n "$port" ]; then
    "$adb_bin" connect "$phone_ip:$port" >/dev/null 2>&1 || true
    if responds "$phone_ip:$port"; then
      printf '%s\n' "$phone_ip:$port"
      return
    fi
    printf '%s\n' "Port $port is not answering; looking for the phone elsewhere." >&2
  fi

  for serial in $(connected_serials); do
    if responds "$serial"; then
      printf '%s\n' "$serial"
      return
    fi
  done

  discovered="$(discover_serial)"
  if [ -n "$discovered" ]; then
    "$adb_bin" connect "$discovered" >/dev/null 2>&1 || true
    if responds "$discovered"; then
      printf '%s\n' "$discovered"
      return
    fi
  fi
}

# Every call is pinned to one serial: the same phone often shows up twice, once
# through mDNS and once through an explicit connect, and an unpinned adb would
# refuse to pick between them.
serial="$(resolve_serial)"
[ -n "$serial" ] || usage

bun -e '
  const expected = { application: "software.luka.personal", version: 1 };
  const response = await fetch("http://127.0.0.1:5173/.well-known/personal-app.json");
  const marker = await response.json();
  if (!response.ok || JSON.stringify(marker) !== JSON.stringify(expected)) {
    throw new Error("Personal dev server is not available on localhost:5173");
  }
'

"$adb_bin" -s "$serial" reverse tcp:5173 tcp:5173 >/dev/null
"$adb_bin" -s "$serial" reverse tcp:8080 tcp:8080 >/dev/null
"$adb_bin" -s "$serial" shell am force-stop software.luka.personal
"$adb_bin" -s "$serial" shell am start -n software.luka.personal/.MainActivity >/dev/null

printf '%s\n' "Android ($serial) is using Personal web/API from localhost."
