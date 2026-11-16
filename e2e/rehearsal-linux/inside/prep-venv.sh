# Finding 4: a project with its own virtual environment holding one package, which check.py needs.
# $1: the agent app. It installed and set up as a participant's.
app=$1; [ "$app" = claude ] && app=claude-code
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null 2>&1
su -l ana -s /bin/bash -c "
[ $app = claude-code ] && node -e 'const f=process.env.HOME+\"/.claude.json\";const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(f,\"utf8\"))}catch{};j.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(j,null,2))'
mkdir -p ~/work && cd ~/work && python3 -m venv .venv && .venv/bin/pip install -q cowsay >/dev/null 2>&1
printf '%s\n' 'import cowsay' 'print(\"venv ok: cowsay\", cowsay.__version__ if hasattr(cowsay, \"__version__\") else \"\")' > check.py
.venv/bin/python check.py; python3 check.py 2>&1 | tail -1
curl -fsSL https://itcan.do/install.sh | IT_INSTALL_PLAIN=1 sh >/dev/null 2>&1; ~/.it/bin/it setup --only $app 2>&1 | tail -1"
