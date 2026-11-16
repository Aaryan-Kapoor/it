# An hour of ordinary hacking: It set up as a participant's for $1, a photo in ~/Pictures for a page that takes a file
app=$1; [ "$app" = claude ] && app=claude-code
su -l ana -s /bin/bash -c "
[ $app = claude-code ] && node -e 'const f=process.env.HOME+\"/.claude.json\";const fs=require(\"fs\");let j={};try{j=JSON.parse(fs.readFileSync(f,\"utf8\"))}catch{};j.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(j,null,2))'
mkdir -p ~/Pictures ~/work
ffmpeg -loglevel error -f lavfi -i color=c=white:s=900x600 -vf 'drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text=LUNCH RECEIPT:fontsize=44:x=60:y=80,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text=Margherita pizza   12.50:fontsize=34:x=60:y=220,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text=Total 15.70:fontsize=38:x=60:y=400' -frames:v 1 -y ~/Pictures/receipt.png
curl -fsSL https://itcan.do/install.sh | IT_INSTALL_PLAIN=1 sh >/dev/null 2>&1; ~/.it/bin/it setup --only $app 2>&1 | tail -1"
