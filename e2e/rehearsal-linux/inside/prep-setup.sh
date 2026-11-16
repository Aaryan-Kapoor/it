# It installed the guide's way (from the stand-in where the run serves a build) and set up for the
# app, from a shell opened before the install: the default prepare of a participant's machine
app=$1; [ "$app" = claude ] && app=claude-code
su -l ana -s /bin/bash -c "sh /build/harness/install-it.sh >/dev/null 2>&1; ~/.it/bin/it setup --only $app 2>&1 | tail -2; ~/.it/bin/it version"
