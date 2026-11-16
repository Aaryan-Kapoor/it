# The participant's upgrade to a candidate: the released 0.1.42 from the real site (the stand-in
# ignored for this), installed and set up the guide's way, by the program's whole path from one
# shell opened before the install; then root's own file runs `it upgrade` through the stand-in.
app=$1; [ "$app" = claude ] && app=claude-code
su -l ana -s /bin/bash -c "
[ $app = claude-code ] && node -e 'const f=process.env.HOME+\"/.claude.json\";const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(f,\"utf8\"))}catch{};j.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(j,null,2))'
env -u IT_INSTALL_BASE sh -c 'curl -fsSL https://itcan.do/install.sh | IT_INSTALL_PLAIN=1 sh' >/dev/null 2>&1
env -u IT_INSTALL_BASE ~/.it/bin/it setup --only $app 2>&1 | tail -1
~/.it/bin/it version | grep -o '0.1.4.'
echo before-upgrade; grep -o 'PATH=[^\"]*' ~/.config/systemd/user/it.service"
printf '%s\n' "su -l ana -s /bin/bash -c 'echo IT_INSTALL_BASE=\$IT_INSTALL_BASE; ~/.it/bin/it upgrade 2>&1 | tail -6; ~/.it/bin/it version | grep -o \"0.1.4.\"; echo after-upgrade; grep -o \"PATH=[^\\\"]*\" ~/.config/systemd/user/it.service'" > /etc/rehearsal-between.sh
chmod 700 /etc/rehearsal-between.sh
