# It installed the guide's way (from the stand-in where the run serves a build) and set up for the
# app, from a shell opened before the install: the default prepare of a participant's machine.
# Claude Code past its first-run screens, as a person signed in already has it (no account details)
app=$1; [ "$app" = claude ] && app=claude-code
if [ "$app" = claude-code ]; then
  su -l ana -s /bin/bash -c 'node -e "const f=process.env.HOME+\"/.claude.json\";const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(f,\"utf8\"))}catch{};j.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(j,null,2))"'
fi
su -l ana -s /bin/bash -c "sh /build/harness/install-it.sh >/dev/null 2>&1; ~/.it/bin/it setup --only $app 2>&1 | tail -2; ~/.it/bin/it version"
