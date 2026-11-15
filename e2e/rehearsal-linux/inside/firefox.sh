#!/bin/sh
# The machine's web browser for a Firefox run: Playwright's build of Firefox, started as a plain
# browser on the right half of the display, with one profile that outlives a restart. A second
# start, such as a link opened from the terminal, opens a tab in the running one. Its content
# sandbox is off, as the container may not make user namespaces.
mkdir -p /opt/person-profile/firefox
export MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GMP_SANDBOX=1 MOZ_DISABLE_RDD_SANDBOX=1 MOZ_DISABLE_SOCKET_PROCESS_SANDBOX=1
exec /opt/ms-playwright/firefox-1532/firefox/firefox --profile /opt/person-profile/firefox --width 960 --height 1080 "$@"
