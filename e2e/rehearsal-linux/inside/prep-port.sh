# Port 4700 already taken by another program before It is installed (a dev server a participant left
# running), then It installed and set up the guide's way. $1: claude or codex
app=$1
systemd-run --unit=other-on-4700 --property=User=nobody python3 -m http.server 4700 --bind 127.0.0.1 >/dev/null 2>&1
sleep 2
echo "before: $(ss -ltnp 2>/dev/null | grep -c ':4700 ') listener(s) on 4700"
sh /build/harness/prep-setup.sh "$app"
echo "after: $(ss -ltnp 2>/dev/null | grep ':47[0-9][0-9] ' | sed -E 's/ +/ /g' | cut -d' ' -f4,6 | tr '\n' ';')"
su -l ana -s /bin/bash -c '~/.it/bin/it site --no-open 2>&1 | head -5; ~/.it/bin/it status 2>&1 | grep -iE "port|url|address" | head -5'
