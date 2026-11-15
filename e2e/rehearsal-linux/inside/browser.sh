#!/bin/sh
# The machine's web browser: Playwright's build of Chromium, started as a plain browser on the
# right half of the display with one profile that outlives a restart. A second start, such as a
# link opened from the terminal, opens a tab in the running one. It runs without Chromium's own
# sandbox, as Playwright runs it, since the container may not make user namespaces; --test-type
# keeps Chromium from showing a bar about that flag to the person.
extra=""
[ -f /etc/rehearsal-fake-media ] && extra="$extra --use-fake-ui-for-media-stream --use-fake-device-for-media-stream"
[ -f /etc/rehearsal-cdp ] && extra="$extra --remote-debugging-port=9222"
exec /opt/ms-playwright/chromium-1228/chrome-linux64/chrome --user-data-dir=/opt/person-profile/chromium \
  --no-sandbox --test-type --no-first-run --no-default-browser-check --password-store=basic --disable-features=Translate \
  --window-position=960,0 --window-size=960,1080 $extra "$@"
