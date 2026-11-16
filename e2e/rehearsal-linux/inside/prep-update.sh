# The agent app as people really have it, under their home and on their shell's PATH only, at an
# older version, with root's own file /etc/rehearsal-between.sh to update it between two clicks.
# $1: claude (the native installer, ~/.local/bin, 2.1.322) or codex (nvm, Codex 0.167.2).
app=$1
if [ "$app" = claude ]; then
  npm rm -g @anthropic-ai/claude-code >/dev/null 2>&1
  su -l ana -s /bin/bash -c '
node -e "const f=process.env.HOME+\"/.claude.json\";const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(f,\"utf8\"))}catch{};j.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(j,null,2))"
curl -fsSL https://claude.ai/install.sh | bash -s 2.1.322 2>&1 | tail -2'
  su -l ana -s /bin/bash -c 'command -v claude; claude --version; sh /build/harness/install-it.sh >/dev/null 2>&1; ~/.it/bin/it setup --only claude-code 2>&1 | tail -1'
  printf '%s\n' "su -l ana -s /bin/bash -c 'claude update 2>&1 | tail -3; claude --version'" > /etc/rehearsal-between.sh
else
  npm rm -g @openai/codex >/dev/null 2>&1
  su -l ana -s /bin/bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null 2>&1'
  su -l ana -s /bin/bash -c 'bash -ic "nvm install 24 >/dev/null 2>&1; npm i -g @openai/codex@0.167.2 >/dev/null 2>&1; command -v codex; codex --version"' 2>/dev/null
  su -l ana -s /bin/bash -c 'node /build/harness/settings.mjs codex gpt-6.1-sol high >/dev/null 2>&1; sh /build/harness/install-it.sh >/dev/null 2>&1; bash -ic "~/.it/bin/it setup --only codex 2>&1 | tail -1"' 2>/dev/null
  printf '%s\n' "su -l ana -s /bin/bash -c 'bash -ic \"npm i -g @openai/codex@latest >/dev/null 2>&1; codex --version\" 2>/dev/null; pkill -u ana -f \"codex app-server\" || true'" > /etc/rehearsal-between.sh
fi
chmod 700 /etc/rehearsal-between.sh
su -l ana -s /bin/bash -c 'grep -o "PATH=[^\"]*" ~/.config/systemd/user/it.service'
# A terminal opened after the install, as a person opens one: the one the harness opened is older
# kill-server returns before the old server is gone, and a new-session that reaches the dying one fails
su -l ana -s /bin/bash -c 'tmux kill-server 2>/dev/null; for i in 1 2 3 4 5; do sleep 1; tmux new-session -d -s agent -x 104 -y 56 -c /home/ana/work 2>/dev/null && break; done; sleep 2; tmux send-keys -t agent "command -v $(test -x ~/.local/bin/claude && echo claude || echo codex)" Enter'
