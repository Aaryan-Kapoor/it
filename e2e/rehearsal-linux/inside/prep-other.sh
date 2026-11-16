# Pi, OpenCode or Hermes installed as their own sites say, the model through OpenRouter (the key is
# already in the app's own settings file, written by the harness), and It set up for it.
app=$1
case $app in
  pi) npm i -g @earendil-works/pi-coding-agent >/dev/null 2>&1; su -l ana -s /bin/bash -c 'pi --version 2>&1 | tail -1' ;;
  opencode) npm i -g opencode-ai@1 >/dev/null 2>&1; su -l ana -s /bin/bash -c 'opencode --version 2>&1 | tail -1' ;;
  hermes) apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq libatomic1 >/dev/null 2>&1
    su -l ana -s /bin/bash -c 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive >/dev/null 2>&1; export PATH=$HOME/.local/bin:$PATH; hermes --version 2>&1 | tail -1; hermes config set model.provider openrouter >/dev/null 2>&1; hermes config set model.default anthropic/claude-haiku-5.5 >/dev/null 2>&1' ;;
esac
su -l ana -s /bin/bash -c "sh /build/harness/install-it.sh >/dev/null 2>&1; ~/.it/bin/it setup --only $app 2>&1 | tail -2"
# Hermes's installer adds ~/.local/bin to ~/.bashrc and asks for a new terminal: the person opens one
if [ "$app" = hermes ]; then
  su -l ana -s /bin/bash -c 'tmux kill-server 2>/dev/null; for i in 1 2 3 4 5; do sleep 1; tmux new-session -d -s agent -x 104 -y 56 -c /home/ana/work 2>/dev/null && break; done'
fi
