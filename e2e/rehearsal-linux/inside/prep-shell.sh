# A participant's shell for finding 8. $1: tmux (a line at the end of ~/.bashrc that starts tmux) or
# fish (fish as the login shell, before It is installed). $2: the agent app. It is installed and set
# up from one login shell opened before the install, as the guide has an agent do it.
export REHEARSAL_HARNESS=1
kind=$1; app=$2
[ "$app" = claude ] && app=claude-code
if [ "$kind" = fish ]; then
  apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fish >/dev/null 2>&1
  chsh -s /usr/bin/fish ana
fi
su -l -w REHEARSAL_HARNESS ana -s /bin/bash -c "
[ $app = claude-code ] && node -e 'const f=process.env.HOME+\"/.claude.json\";const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(f,\"utf8\"))}catch{};j.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(j,null,2))'
SHELL=\$(getent passwd ana | cut -d: -f7) sh /build/harness/install-it.sh >/dev/null 2>&1
~/.it/bin/it setup --only $app 2>&1 | tail -2
grep -o 'PATH=[^\"]*' ~/.config/systemd/user/it.service | grep -c '.it/bin' | sed 's/^/unit PATH has .it\/bin: /'
"
if [ "$kind" = tmux ]; then echo '[ -z "$TMUX" ] && exec tmux new -A -s main' >> /home/ana/.bashrc; fi
# The line first in ~/.bashrc, as the audit has it; the harness's own shells carry REHEARSAL_HARNESS and pass it by
if [ "$kind" = tmuxfirst ]; then sed -i '1i [ -z "$TMUX" ] \&\& [ -z "$REHEARSAL_HARNESS" ] \&\& exec tmux new -A -s main' /home/ana/.bashrc; head -1 /home/ana/.bashrc; fi
# The same line with the guard many snippets carry, for interactive shells only
if [ "$kind" = tmuxfirsti ]; then sed -i '1i [[ $- == *i* ]] \&\& [ -z "$TMUX" ] \&\& [ -z "$REHEARSAL_HARNESS" ] \&\& exec tmux new -A -s main' /home/ana/.bashrc; head -1 /home/ana/.bashrc; fi
# The user manager and It's service started again, with the shell as it now is
systemctl restart user@1000.service; sleep 3
# That ended the terminal's session too: the person opens a terminal again, in their own login shell
su -l -w REHEARSAL_HARNESS ana -s /bin/bash -c 'tmux new-session -d -s agent -x 104 -y 56 -c /home/ana/work' > /var/lib/rehearsal-flow/prep-shell.log 2>&1
su -l -w REHEARSAL_HARNESS ana -s /bin/bash -c 'tmux list-sessions; tmux display -p -t agent "pane shell: #{pane_current_command}"'
su -l -w REHEARSAL_HARNESS ana -s /bin/bash -c 'systemctl --user start it.service; sleep 15; ~/.it/bin/it service logs 2>&1 | grep -i "reopens are given" | tail -1'
