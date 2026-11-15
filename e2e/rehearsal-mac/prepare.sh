#!/bin/bash
# Prepares a rented Mac for one rehearsal run, before the video starts. Run on the Mac as its user
# `runner`, from the folder the harness uploaded (~/rehearsal-upload), by run.mjs:
#
#   bash prepare.sh tools                 the recorder, tmux, the hands, their permissions
#   bash prepare.sh standin               the build under test served as It's releases on 127.0.0.1:8765
#   bash prepare.sh app codex|claude      the agent app, installed as a participant would have it
#   bash prepare.sh desktop safari|chrome the Terminal on the left, empty, and the browser on the right
#   bash prepare.sh facts                 what the run records about the Mac
#
# Nothing here signs anything in: secrets.mjs does that, over standard input.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
BASE=http://127.0.0.1:8765
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
# Runs a command inside the desktop session, as runner, where the screen and the input are
gui() { sudo launchctl asuser 501 sudo -u runner -H "$@"; }

tcc_grant() { # service, path: allows one program a protected service, in the system's database
  sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
    "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags, last_modified) VALUES ('$1', '$2', 1, 2, 4, 1, 0, CAST(strftime('%s','now') AS INTEGER));"
}

case "${1:-}" in
tools)
  sudo mkdir -p /usr/local/bin /Users/Shared/rehearsal
  sudo chown runner /Users/Shared/rehearsal
  if [ ! -x /usr/local/bin/ffmpeg ]; then
    curl -fsSL -o /tmp/ffmpeg.zip https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip
    (cd /tmp && unzip -o -q ffmpeg.zip ffmpeg) && sudo mv /tmp/ffmpeg /usr/local/bin/ffmpeg && sudo chmod 755 /usr/local/bin/ffmpeg
    sudo xattr -c /usr/local/bin/ffmpeg 2>/dev/null || true
  fi
  command -v tmux >/dev/null || brew install -q tmux >/dev/null
  swiftc -O -o /tmp/hands "$here/hands.swift" && sudo mv /tmp/hands /usr/local/bin/hands
  for s in kTCCServiceAccessibility kTCCServicePostEvent kTCCServiceListenEvent; do tcc_grant "$s" /usr/local/bin/hands; done
  for p in /usr/local/bin/ffmpeg /usr/sbin/screencapture; do tcc_grant kTCCServiceScreenCapture "$p"; done
  # The screen never sleeps or locks while a run is recorded
  sudo pmset -a displaysleep 0 sleep 0 >/dev/null 2>&1 || true
  gui defaults -currentHost write com.apple.screensaver idleTime -int 0 || true
  printf 'set -g status off\nset -g history-limit 50000\nset -g default-terminal "xterm-256color"\n' > ~/.tmux.conf
  echo "tools ready"
  ;;
standin)
  mkdir -p ~/stand-in
  cp "$here"/bin/* ~/stand-in/
  # The install script and `it upgrade` look for the build under test here: in every zsh the
  # person or an agent starts, and in what the desktop session starts
  grep -q IT_INSTALL_BASE ~/.zshenv 2>/dev/null || echo "export IT_INSTALL_BASE=$BASE" >> ~/.zshenv
  grep -q IT_INSTALL_BASE ~/.bash_profile 2>/dev/null || echo "export IT_INSTALL_BASE=$BASE" >> ~/.bash_profile
  gui launchctl setenv IT_INSTALL_BASE "$BASE"
  if ! curl -fsS -o /dev/null "$BASE/latest/download/latest.json" 2>/dev/null; then
    bash -c 'trap "" HUP; exec node "$0" "$1" 8765' "$here/releases.mjs" "$HOME/stand-in" >> /Users/Shared/rehearsal/releases.log 2>&1 < /dev/null &
    for _ in $(seq 20); do curl -fsS -o /dev/null "$BASE/latest/download/latest.json" 2>/dev/null && break; sleep 0.5; done
  fi
  curl -fsS "$BASE/latest/download/latest.json"
  echo
  ;;
app)
  case "${2:-}" in
  codex)
    command -v codex >/dev/null || npm install -g --silent @openai/codex@latest >/dev/null 2>&1
    mkdir -p ~/.codex && chmod 700 ~/.codex
    # The owner's ChatGPT account has apps of its own, which Codex would offer its model as
    # tools; a participant's has none. The sign-in is kept in the file secrets.mjs writes.
    printf 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\ncli_auth_credentials_store = "file"\n\n[features]\napps = false\n' > ~/.codex/config.toml
    codex --version
    ;;
  claude)
    command -v claude >/dev/null || npm install -g --silent @anthropic-ai/claude-code@latest >/dev/null 2>&1
    mkdir -p ~/.claude && chmod 700 ~/.claude
    claude --version
    ;;
  *) echo "app codex|claude"; exit 2 ;;
  esac
  mkdir -p ~/work
  ;;
desktop)
  browser=${2:-safari}
  mkdir -p ~/work
  # The person's Terminal: one window, a login shell in ~/work, inside tmux so that the harness
  # can read what it shows
  cat > ~/Terminal.command <<'EOF'
#!/bin/zsh -l
cd ~/work
clear
exec /opt/homebrew/bin/tmux new-session -A -s agent
EOF
  chmod 755 ~/Terminal.command
  # A Terminal left from an earlier step is closed, so that the person meets an empty one
  /opt/homebrew/bin/tmux kill-server 2>/dev/null || true
  gui osascript -e 'quit app "Terminal"' 2>/dev/null || true
  rm -f ~/.zsh_history; rm -rf ~/.zsh_sessions
  sleep 1
  if [ "$browser" = chrome ]; then
    sudo xattr -dr com.apple.quarantine "/Applications/Google Chrome.app" 2>/dev/null || true
  fi
  gui open -a Terminal ~/Terminal.command
  sleep 3
  if [ "$browser" = chrome ]; then
    gui open -a "Google Chrome" --args --no-first-run --no-default-browser-check about:blank || true
  else
    gui open -a Safari
  fi
  sleep 4
  echo "desktop opened"
  ;;
place)
  # Terminal on the left half and the browser on the right, in the screen's points
  read -r W H _ < <(gui /usr/local/bin/hands size)
  top=${3:-25}
  half=$((W / 2))
  app=${2:-Safari}
  gui /usr/local/bin/hands place Terminal 0 "$top" "$half" $((H - top)) || true
  gui /usr/local/bin/hands place "$app" "$half" "$top" "$half" $((H - top)) || true
  echo "placed in ${W}x${H}"
  ;;
facts)
  echo "macos=$(sw_vers -productVersion) build=$(sw_vers -buildVersion)"
  echo "model=$(sysctl -n hw.model) cpus=$(sysctl -n hw.ncpu) mem=$(($(sysctl -n hw.memsize) / 1073741824))GB"
  echo "node=$(node --version 2>/dev/null) brew=$(brew --version 2>/dev/null | head -1)"
  echo "safari=$(defaults read /Applications/Safari.app/Contents/Info CFBundleShortVersionString 2>/dev/null)"
  echo "chrome=$(defaults read "/Applications/Google Chrome.app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
  echo "screen=$(gui /usr/local/bin/hands size 2>/dev/null)"
  echo "swift=$(swiftc --version 2>&1 | head -1)"
  ;;
*)
  sed -n '2,12p' "$0"
  exit 2
  ;;
esac
