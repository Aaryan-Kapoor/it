# Claude Code against a stand-in for its model (inside/standin.mjs), with a made-up key and no
# sign-in, on a participant machine: the stand-in and the key in Claude Code's own settings, which
# a conversation It reopens reads too; It installed and set up as a participant's.
su -l ana -s /bin/bash -c '
K=a-made-up-key-for-a-stand-in-model-000000
node -e "
const fs=require(\"fs\"), h=process.env.HOME, k=process.argv[1];
const cj=h+\"/.claude.json\"; let j={}; try{j=JSON.parse(fs.readFileSync(cj,\"utf8\"))}catch{}
j.hasCompletedOnboarding=true; j.customApiKeyResponses={approved:[k.slice(-20)],rejected:[]};
j.projects=Object.assign(j.projects||{},{\"/home/ana/work\":{hasTrustDialogAccepted:true}}); fs.writeFileSync(cj,JSON.stringify(j,null,2));
fs.mkdirSync(h+\"/.claude\",{recursive:true}); const sf=h+\"/.claude/settings.json\"; let s={}; try{s=JSON.parse(fs.readFileSync(sf,\"utf8\"))}catch{}
s.env=Object.assign(s.env||{},{ANTHROPIC_BASE_URL:\"http://127.0.0.1:8899\",ANTHROPIC_API_KEY:k}); fs.writeFileSync(sf,JSON.stringify(s,null,2));
" $K
mkdir -p ~/work
systemd-run --user --unit=standin -E STANDIN_PORT=8899 /usr/local/bin/node /build/harness/standin.mjs >/dev/null 2>&1; sleep 2; tail -1 /tmp/standin.log
curl -fsSL https://itcan.do/install.sh | IT_INSTALL_PLAIN=1 sh >/dev/null 2>&1; ~/.it/bin/it setup --only claude-code 2>&1 | tail -1'
