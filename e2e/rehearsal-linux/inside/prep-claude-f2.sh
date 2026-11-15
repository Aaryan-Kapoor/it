# Claude Code as a participant keeps it: a server added for every project (in ~/.claude.json), a
# hook in the project's own settings, the project trusted at Claude Code's own question; It set up
su -l ana -c '
mkdir -p ~/bin ~/work/.claude
# What /login leaves in ~/.claude.json besides the account: onboarding done (no account details are written here)
node -e "const f=process.env.HOME+\"/.claude.json\";const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(f,\"utf8\"))}catch{};j.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(j,null,2))"
cat > ~/bin/marker-server <<"S"
#!/bin/sh
touch /tmp/it-marker-server-$(date +%s%N)
exec cat >/dev/null
S
chmod +x ~/bin/marker-server
claude mcp add --scope user marker -- /home/ana/bin/marker-server >/dev/null 2>&1; claude mcp list 2>&1 | grep -c marker
printf "%s\n" "{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"touch /tmp/it-marker-hook-\$(date +%s%N)\"}]}]}}" > ~/work/.claude/settings.json
curl -fsSL https://itcan.do/install.sh | IT_INSTALL_PLAIN=1 sh >/dev/null 2>&1; ~/.it/bin/it setup --only claude-code 2>&1 | tail -2; ~/.it/bin/it version | grep -o 0.1.42'
