# It's install script from the real site, or from the stand-in where the run serves a build under test
if [ -n "$IT_INSTALL_BASE" ]; then u="$IT_INSTALL_BASE/latest/download/install.sh"; else u=https://itcan.do/install.sh; fi
curl -fsSL "$u" | IT_INSTALL_PLAIN=1 sh
