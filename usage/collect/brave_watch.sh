#!/usr/bin/env bash
# brave_watch.sh — cable-free Brave history watcher (wireless ADB, no root, no sync).
#
# Loops forever and removes all manual work across Brave install/uninstall cycles:
#   1. keeps adb connected to the phone (paired wireless TLS, USB as fallback),
#   2. watches com.brave.browser for user 0,
#   3. on each fresh install/reinstall: wakes the phone, taps through Brave's
#      first-run screens (SKIP-only: never taps Accept/Continue/Enable), takes a
#      usagestats snapshot and scrapes the History screen via scrape_phone_history.py,
#   4. on uninstall: logs it and goes back to watching.
#
# Run from this directory:  ./brave_watch.sh   (or: WATCH_ONCE=1 ./brave_watch.sh for one pass)
#
# Env overrides:
#   DEVICE_HOST=<phone LAN IP>  DEVICE_PORT=<port>   wireless TLS endpoint (required)
#     (port is shown under Wireless debugging; it can change after a reboot —
#      update DEVICE_PORT, pairing itself persists, no cable needed)
#   POLL_SECONDS=30           how often to check install state
#   RESCRAPE_HOURS=0          re-scrape while installed every N hours (0 = only on fresh install)
#   WATCH_ONCE=1              single pass, then exit (for testing)
set -u
cd "$(dirname "$0")"

PKG=com.brave.browser
DEVICE_HOST="${DEVICE_HOST:?set DEVICE_HOST to the phone IP (Wireless debugging screen)}"
DEVICE_PORT="${DEVICE_PORT:?set DEVICE_PORT to the wireless debugging port}"
SERIAL="$DEVICE_HOST:$DEVICE_PORT"
POLL_SECONDS="${POLL_SECONDS:-30}"
RESCRAPE_HOURS="${RESCRAPE_HOURS:-0}"
DATA_DIR="../data/phone"
STATE_FILE="$DATA_DIR/.brave_watch.state"   # "<firstInstallTime> <scraped:0|1> <lastScrapeEpoch>"
LOG_FILE="$DATA_DIR/brave_watch.log"

export ANDROID_SERIAL="$SERIAL"   # makes every plain `adb` call (adbui.py, phone.py) use wireless
mkdir -p "$DATA_DIR"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

adb_ok() { adb -s "$SERIAL" shell echo ok >/dev/null 2>&1; }

ensure_device() {
    if adb_ok; then return 0; fi
    log "wireless $SERIAL unreachable, (re)connecting..."
    adb connect "$SERIAL" >/dev/null 2>&1
    if adb_ok; then log "connected to $SERIAL"; return 0; fi
    # fallback: any USB-attached device
    local usb
    usb="$(adb devices | awk '$2=="device" && $1 !~ /:/ {print $1; exit}')"
    if [ -n "$usb" ]; then
        log "using USB fallback $usb (update DEVICE_PORT from Wireless debugging for cable-free)"
        export ANDROID_SERIAL="$usb"
        SERIAL="$usb"
        return 0
    fi
    log "no device. If the phone rebooted, check the port under Wireless debugging and set DEVICE_PORT."
    return 1
}

installed() { [ -n "$(adb shell pm path --user 0 "$PKG" 2>/dev/null)" ]; }

install_time() {
    adb shell dumpsys package "$PKG" 2>/dev/null | grep -m1 firstInstallTime | sed 's/.*firstInstallTime=//;s/[[:space:]]*$//'
}

# Best-effort first-run dismissal. SKIP-ONLY: taps Skip / Not now / No thanks /
# Maybe later — never Continue / Accept / Enable / Turn on, so it can't opt you
# into Rewards, notifications or anything else. Returns 0 if the History menu is reachable.
dismiss_first_run() {
    python3 - "$PKG" <<'EOF'
import sys, time
import adbui
pkg = sys.argv[1]
adbui.sh("input", "keyevent", "KEYCODE_WAKEUP")
adbui.sh("monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")
time.sleep(3)
SKIP = ("skip", "not now", "no thanks", "maybe later", "don't allow", "no, thanks")
for _ in range(12):
    hit = adbui.tap_where(lambda n: (n.get("text") or "").strip().lower() in SKIP)
    time.sleep(1.5)
    if not hit:
        break
ok = adbui.tap_where(lambda n: n.get("resource-id", "").split("/")[-1] in ("menu_button", "menu_button_wrapper"))
print("first-run: menu reachable" if ok else "first-run: menu NOT reachable yet (one manual skip tap may be needed)")
EOF
}

do_collect() {
    log "collecting: usagestats snapshot + history scrape"
    python3 -c "import phone; phone.snapshot(); print('usagestats snapshot saved')" 2>&1 | tee -a "$LOG_FILE"
    if python3 scrape_phone_history.py "$PKG" 2>&1 | tee -a "$LOG_FILE"; then
        log "scrape finished"
        return 0
    fi
    log "scrape FAILED (phone may be locked or Brave onboarding still open) — will retry"
    return 1
}

load_state() {
    if [ -f "$STATE_FILE" ]; then cat "$STATE_FILE"; else echo ""; fi
}

pass_once() {
    ensure_device || return 0
    local st it scraped last
    st="$(load_state)"
    it="" ; scraped=0; last=0
    if installed; then
        it="$(install_time)"
        if [ -n "$st" ] && [ "${st%% *}" = "$it" ]; then
            scraped="$(echo "$st" | awk '{print $2+0}')"
            last="$(echo "$st" | awk '{print $3+0}')"
        fi
        if [ "$it" != "${st%% *}" ]; then
            log "fresh install detected ($PKG, firstInstallTime=$it)"
            scraped=0
        fi
        due=0
        [ "$scraped" = "0" ] && due=1
        if [ "$RESCRAPE_HOURS" -gt 0 ] && [ "$last" -gt 0 ] \
           && [ $(( $(date +%s) - last )) -ge $(( RESCRAPE_HOURS * 3600 )) ]; then due=1; fi
        if [ "$due" = "1" ]; then
            dismiss_first_run | tee -a "$LOG_FILE"
            if do_collect; then
                echo "$it 1 $(date +%s)" > "$STATE_FILE"
            else
                echo "$it 0 $last" > "$STATE_FILE"
            fi
        fi
    else
        if [ -n "$st" ]; then
            log "uninstalled ($PKG gone for user 0) — back to watching"
            rm -f "$STATE_FILE"
        fi
    fi
}

log "watch started (target $SERIAL, poll ${POLL_SECONDS}s, rescrape ${RESCRAPE_HOURS}h)"
if [ "${WATCH_ONCE:-0}" = "1" ]; then
    pass_once
    exit 0
fi
while true; do
    pass_once
    sleep "$POLL_SECONDS"
done
