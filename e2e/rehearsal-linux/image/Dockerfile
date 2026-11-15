# A clean Linux laptop for the rehearsal: systemd as the first process, an ordinary user `ana`
# who lingers, a virtual display with a small window manager, a terminal, a browser driven by
# Playwright as "the person", and the agent apps at the versions given. Nothing of It.
ARG UBUNTU=24.04
FROM ubuntu:${UBUNTU}
ARG NODE=24.11.1
ARG PLAYWRIGHT=1.61.0
ARG CODEX=latest
ARG CLAUDE=latest
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session libpam-systemd \
      xvfb openbox xterm tmux ffmpeg xdotool x11-utils wmctrl \
      curl ca-certificates git python3 procps less nano psmisc lsof \
      fonts-dejavu-core fonts-liberation xz-utils iproute2 \
    && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-${arch}.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
    && node --version
# The person: Playwright and its browsers, outside ana's home
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN mkdir -p /opt/person && cd /opt/person && npm init -y >/dev/null && npm i playwright@${PLAYWRIGHT} >/dev/null \
    && npx playwright install --with-deps chromium firefox && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/ms-playwright /opt/person
# The agent apps, from their official packages
RUN npm i -g @openai/codex@${CODEX} @anthropic-ai/claude-code@${CLAUDE} && npm cache clean --force \
    && codex --version && claude --version
# The person's machine: one user, lingering so her services outlive a session
RUN (userdel -r ubuntu 2>/dev/null || true) && useradd -m -s /bin/bash -u 1000 ana \
    && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/ana
# systemd in a container: no getty, no units that need hardware
RUN systemctl mask getty@tty1.service console-getty.service systemd-udevd.service systemd-udev-trigger.service \
      systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount 2>/dev/null; \
    systemctl set-default multi-user.target
COPY units/ /etc/systemd/system/
RUN systemctl enable rehearsal-xvfb.service rehearsal-wm.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
# The desktop a person uses: a terminal whose links open with Ctrl and a click, and the plain
# browser as the system's browser for every link.
RUN apt-get update && apt-get install -y --no-install-recommends xfce4-terminal xdg-utils dbus-x11 at-spi2-core \
    && rm -rf /var/lib/apt/lists/*
COPY browser /usr/local/bin/browser
COPY rehearsal-browser.desktop /usr/share/applications/rehearsal-browser.desktop
COPY mimeapps.list /etc/xdg/mimeapps.list
RUN chmod 755 /usr/local/bin/browser && update-desktop-database /usr/share/applications 2>/dev/null || true; \
    update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/browser 300
