#!/bin/sh
# Installs It on your computer: one program, in ~/.it/bin.
#
#   curl -fsSL https://itcan.do/install.sh | sh
#
# It downloads the program for this system, checks it against the published checksum, and puts
# it in ~/.it/bin, with the license it comes under and the notices of what it includes in ~/.it.
# It needs curl, and sha256sum or shasum, and beyond those only commands that every Linux and
# macOS system has. It needs no root rights, and asks for none.
#
# What it installs goes in ~/.it, or in the folder IT_HOME names instead, and that folder is set
# so that only you can look inside it. Outside that folder it changes one thing: the file your
# shell reads when it starts, so that the program's folder is on your PATH. For zsh that is
# .zshrc, in the folder ZDOTDIR names if it names one. For bash it is .bashrc and whichever of
# .bash_profile, .bash_login and .profile a login shell reads. For any other shell it is
# .profile. Each of those is given a blank line, a comment and one line, once, and is made if
# it is not there.
#
# To join an It that runs on another computer, give it the command that It's site shows under
# Machines, Add a machine:
#
#   curl -fsSL https://itcan.do/install.sh | sh -s -- login --url <address> --code <code>
#
# The program is installed as above and then joins that It, and no It is set up here: a
# computer runs It or joins one, and one that has set up its own cannot join.
#
# IT_INSTALL_BASE names another place to download from, laid out as GitHub lays out a
# repository's releases. IT_VERSION names a release other than the latest, by its tag.
# IT_INSTALL_NO_PATH, set to anything, leaves your PATH and your shell's profile alone.
#
# Plain letters only in this script, and every name in braces where a letter could follow it:
# some shells read a character that is not plain as part of the name before it. And no `--`
# after a command's first plain argument: macOS's commands stop looking for options there, and
# read it as a file's name. Every path given to a command with no `--` before it is absolute,
# so it needs none.
#
# Everything is inside one pair of braces, which a shell reads to the end before it runs any of
# it. A script cut short on its way, as one piped from curl can be, then does nothing at all.
set -eu
{

# Everything said here is printed exactly as it is. A folder's name may hold what `echo` would
# read as something other than the characters in it, and a command printed for a person to copy
# must be the command that was meant.
say() { printf '%s\n' "$1"; }
# A path as one word a shell reads back exactly, whatever characters are in it
quoted() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# A person at a terminal is shown a few short lines, each with a mark, and is then led through
# the setup by the program itself. Anywhere else (a script, an agent, a file) everything is said
# in whole sentences, since whatever reads it there reads words. An agent app may give the
# commands it runs a terminal, so one that names its conversation is not taken for a person.
# IT_INSTALL_PLAIN, set to anything, asks for the sentences at a terminal too.
agent="${CLAUDE_CODE_SESSION_ID:-}${CODEX_THREAD_ID:-}${OPENCLAW_SESSION_ID:-}${HERMES_SESSION_ID:-}${OPENCODE_SESSION_ID:-}${PI_SESSION_ID:-}${IT_SESSION:-}"
led=0
if [ -t 1 ] && [ -z "${agent}" ] && [ -z "${IT_INSTALL_PLAIN:-}" ]; then led=1; fi
did() { printf '  \033[32m\342\234\223\033[0m %s\n' "$1"; }
mind() { printf '  \033[33m!\033[0m %s\n' "$1"; }
quietly() { printf '  \033[2m%s\033[0m\n' "$1"; }

# What is given after the script: nothing, or `login` and what `it login` takes, which joins
# an It on another computer once the program is in. Looked at before anything is downloaded.
join=0
if [ "$#" -gt 0 ]; then
  if [ "$1" != login ]; then
    say "This script takes nothing after it, or what joins an It that runs on another computer: login --url <address> --code <code>. It does not know what to do with \"$1\". Nothing was installed." >&2
    exit 2
  fi
  join=1
fi

BASE="${IT_INSTALL_BASE:-https://itcan.do/releases}"
BASE="${BASE%/}"
VERSION="${IT_VERSION:-latest}"

# Where it goes. Settled before anything is downloaded, so that nothing is half done when a
# folder cannot be worked out.
if [ -n "${IT_HOME:-}" ]; then HOME_DIR="${IT_HOME}"
elif [ -n "${HOME:-}" ]; then HOME_DIR="${HOME}/.it"
else say "Neither HOME nor IT_HOME is set, so there is nowhere to install It." >&2; exit 1
fi
# A folder given as a relative path is taken from where this was run, and is never read as an
# option by the commands below, whatever its first character is
case "${HOME_DIR}" in
  /*) ;;
  *) HOME_DIR="$(pwd)/${HOME_DIR}" ;;
esac
DIR="${HOME_DIR}/bin"

case "${VERSION}" in
  latest) FROM="${BASE}/latest/download" ;;
  *[!A-Za-z0-9._-]*|'') say "IT_VERSION must be a release's tag." >&2; exit 1 ;;
  *) FROM="${BASE}/download/${VERSION}" ;;
esac

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) say "It has no program for $(uname -s). On Windows, use install.ps1." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) say "It has no program for $(uname -m)." >&2; exit 1 ;;
esac
# A shell that is itself run under translation on a Mac with an Apple chip says the chip is
# Intel's. The Mac says when that is so, and is given the program for the chip it has.
if [ "${os}" = darwin ] && [ "${arch}" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
name="it-${os}-${arch}"

# On Linux the programs are built for the GNU C library, and the backend program It runs needs
# version 2.35 of it or newer. A system with another C library has no program at all, and is
# told so before anything is downloaded. One whose library is older can still hold the `it`
# command, which joins an It that runs on another machine, so it is installed and told.
old_libc=""
if [ "${os}" = linux ]; then
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  case "${libc}" in
    glibc\ [0-9]*.[0-9]*)
      libc="${libc#glibc }"
      libc_major="${libc%%.*}"
      libc_minor="${libc#*.}"; libc_minor="${libc_minor%%.*}"
      case "${libc_major}${libc_minor}" in
        *[!0-9]*) ;;
        *) if [ "${libc_major}" -lt 2 ] || { [ "${libc_major}" -eq 2 ] && [ "${libc_minor}" -lt 35 ]; }; then old_libc="${libc}"; fi ;;
      esac ;;
    *)
      if { ldd --version 2>&1 || true; } | grep -qi musl; then
        say "It has no program for this system: its programs are built for the GNU C library, and this system has musl, as Alpine does." >&2
        exit 1
      fi ;;
  esac
fi

# Only over https, and a redirect may only lead to https. The one exception is a base on this
# machine itself, which is how the install is tested before anything is published: it must be
# exactly this machine and a port, with nothing a browser would read as a name and password
# before it, it is not followed anywhere else, and it is asked directly, whatever proxy the
# environment names: a proxy would carry what is asked of this machine off it, in the clear.
plain=0
case "${BASE}" in
  https://*) ;;
  http://127.0.0.1:*|http://localhost:*)
    rest="${BASE#http://}"
    rest="${rest#*:}"
    port="${rest%%/*}"
    case "${port}" in
      ''|*[!0-9]*) say "IT_INSTALL_BASE must be an https address." >&2; exit 1 ;;
    esac
    plain=1
    ;;
  *) say "IT_INSTALL_BASE must be an https address." >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { say "Install curl first." >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || { say "Install sha256sum or shasum first." >&2; exit 1; }
fetch() {
  if [ "${plain}" = 1 ]; then curl -fsS --noproxy '*' --max-redirs 0 "$1" -o "$2"
  else curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" -o "$2"
  fi
  # What curl leaves is an ordinary file. Anything else there is not a download, and is not read
  if [ ! -f "$2" ] || [ -L "$2" ]; then
    say "What was downloaded from $1 is not an ordinary file. Nothing was installed." >&2
    exit 1
  fi
}
# Read from the file's contents, never by its name: a name with an odd character in it changes
# what these programs print
sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1
  else shasum -a 256 < "$1" | cut -d' ' -f1
  fi
}

mkdir -p -- "${DIR}"
# Only this user may look inside It's folder: the machine's key is kept there. Whether that is
# so is read back from the folder itself, since setting it can be refused, and on some disks
# does nothing: a folder that others can look inside is not installed into, and that is found
# out before anything is downloaded.
chmod 700 "${HOME_DIR}" 2>/dev/null || true
case "$(ls -ld "${HOME_DIR}/." 2>/dev/null)" in
  d???--[-S]--[-T]*) ;;
  *)
    say "${HOME_DIR} could not be set so that only you can look inside it, and It keeps this machine's key there. Nothing was installed. Set IT_HOME to a folder of your own that can be." >&2
    exit 1
    ;;
esac
# A Mac keeps a second list of who may open a folder, which those permissions say nothing of.
# An entry there that allows anything lets someone in past them.
if [ "${os}" = darwin ] && ls -lde "${HOME_DIR}/." 2>/dev/null | sed 1d | grep -q ' allow '; then
  say "${HOME_DIR} has an access list that lets others look inside it, and It keeps this machine's key there. Nothing was installed. Take the list away with  chmod -N $(quoted "${HOME_DIR}")  or set IT_HOME to a folder of your own." >&2
  exit 1
fi

# A folder where one of the three files is to go is never installed over, nor into, and that is
# found out before anything is downloaded.
no_folder() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    say "$1 is a folder, and It is not installed over one. Nothing was installed." >&2
    exit 1
  fi
}
no_folder "${DIR}/it"
no_folder "${HOME_DIR}/LICENSE.md"
no_folder "${HOME_DIR}/THIRD_PARTY_NOTICES.md"

# The folder the downloads are kept in, once it has been made
stage=""
# One install at a time puts its files in place. The lock is a folder, which only one can make,
# and in it a file that names the install that holds it: its process, and the machine that
# process is on. An install holds its lock for as long as it is running, however long that is.
lock="${HOME_DIR}/.installing"
here="$(uname -n)"
me="$$ ${here}"
locked=0
took=0
# Whether a process is running. One that is someone else's cannot be sent a signal, and is
# looked for by its number, where there is a `ps` to ask.
running() { kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1; }
# What the lock says of who holds it: which process, on which machine. Both are empty where it
# does not say.
holder() {
  IFS= read -r held 2>/dev/null < "${lock}/owner" || held=""
  by="${held%% *}"
  on="${held#* }"
  case "${held}" in *" "*) ;; *) by="" ;; esac
  case "${by}" in ''|*[!0-9]*) by=""; on="" ;; esac
}
# The lock is given up only by the install it names
unlock() {
  holder
  if [ "${held}" = "${me}" ]; then
    rm -f -- "${lock}/owner" 2>/dev/null || true
    rmdir "${lock}" 2>/dev/null || true
  fi
  locked=0
}
# The three files are put in place together or not at all. What was at each place is kept
# aside, in the folder made for this run, until all three are in. Stopped
# before then, what was there is put back: the old file where one was kept, and nothing where
# the new file went in over nothing.
replacing=0
# Which of the three this run has begun to put in place, and whether something that was moved
# aside could not be put back
begun=""
kept=0
replace() {
  no_folder "$2"
  # What is there is kept aside without being taken away: under a second name for the same
  # file, or failing that as a copy. The new file is then moved over it, which the system does
  # in one step. So at no moment is there nothing at the place: a run that is ended between the
  # two, or a machine that loses power, still has a program where its service starts it from.
  # A link is kept aside as the link it is, by a copy of the link and not of what it leads to,
  # since a second name for a link is not the same on every system; and only where it cannot
  # be copied so is it moved aside, which leaves nothing at the place for a moment.
  # A link that leads to a folder is always moved aside: a file moved onto such a link would
  # be put inside the folder.
  if [ -L "$2" ] && [ ! -d "$2" ] && cp -P -- "$2" "${stage}/old.$1" 2>/dev/null; then :
  elif [ -L "$2" ]; then mv -f -- "$2" "${stage}/old.$1"
  elif [ -e "$2" ] && ! ln -- "$2" "${stage}/old.$1" 2>/dev/null; then
    # A copy is made under a name of its own and given the kept name only once it is whole: a
    # copy that stopped half way, as on a full disk, is never taken for what was there
    cp -p -- "$2" "${stage}/old.$1.part"
    mv -f -- "${stage}/old.$1.part" "${stage}/old.$1"
  fi
  begun="${begun} $1"
  # The new file is brought beside the place under a name of its own, and renamed from there.
  # Where the folder made for this run is on another disk than the place, the first of the two
  # is a copy that takes time and may be cut short, and the second is still the one step
  mv -f -- "${stage}/$1" "$2.it-new.$$"
  mv -f -- "$2.it-new.$$" "$2"
}
put_back() {
  # A new file that was on its way in and never got its name
  rm -f -- "$2.it-new.$$" || true
  if [ -e "${stage}/old.$1" ] || [ -L "${stage}/old.$1" ]; then
    # Kept aside under a second name, it may still be what is at the place, where the new file
    # never went in: then there is nothing to put back, and only the second name to take away
    if [ "${stage}/old.$1" -ef "$2" ]; then rm -f -- "${stage}/old.$1" || true
    else mv -f -- "${stage}/old.$1" "$2" || kept=1
    fi
  else
    # Nothing was moved aside. What is there now is taken away only if this run put it there:
    # anything else was there before, and is not this run's to remove
    case " ${begun} " in
      *" $1 "*) if [ ! -e "${stage}/$1" ]; then rm -f -- "$2" || true; fi ;;
    esac
  fi
}
cleanup() {
  # Once it is clearing up, a further signal does not stop it half way
  trap ':' HUP INT QUIT PIPE TERM
  if [ "${replacing}" = 1 ]; then
    put_back notices "${HOME_DIR}/THIRD_PARTY_NOTICES.md"
    put_back license "${HOME_DIR}/LICENSE.md"
    put_back program "${DIR}/it"
  fi
  # A file that could not be put back is the only copy there is, and stays where it is
  if [ "${kept}" = 1 ]; then say "Not everything that was there before could be put back. What could not is kept in ${stage}." >&2 || true
  elif [ -n "${stage}" ]; then rm -rf -- "${stage}" || true
  fi
  if [ "${locked}" = 1 ]; then unlock; fi
}
trap cleanup EXIT
# Stopped by a signal, it still clears up after itself, and says by its exit how it ended. So
# it does when what it prints cannot be written, as when the program it is piped to has
# ended: some shells would otherwise end there and clear nothing up.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 141' PIPE
trap 'exit 143' TERM

# What is downloaded is kept, until it has been checked, in a folder made for this run, which
# only this user can look inside and which nothing can have been put in beforehand. Its name
# cannot be guessed. On a system with no mktemp its name can be, and there making it fails if
# anything at all is already at that name.
if command -v mktemp >/dev/null 2>&1; then made=$(mktemp -d "${HOME_DIR}/.install.XXXXXX")
else made="${HOME_DIR}/.install.$$"; mkdir -m 700 "${made}"
fi
stage="${made}"
# The folder names the install that made it, as the lock does, so that one left behind by an
# install that was killed can be told from one in use. Such a folder holds a whole program, and
# is cleared here once its install is gone from this machine: unless it holds a file that was
# moved aside, which may be the only copy there is, and is kept until a person removes it.
say "${me}" > "${stage}/owner"
for left in "${HOME_DIR}"/.install.*; do
  if [ "${left}" = "${stage}" ] || [ ! -d "${left}" ] || [ -L "${left}" ]; then continue; fi
  IFS= read -r was 2>/dev/null < "${left}/owner" || continue
  case "${was}" in
    *[!0-9]*" ${here}"|" ${here}") continue ;;
    *" ${here}") ;;
    *) continue ;;
  esac
  if running "${was%% *}" || ls "${left}"/old.* >/dev/null 2>&1; then continue; fi
  rm -rf -- "${left}" || true
done

# Each file is checked against the published checksum before it is put anywhere. The line for
# a file is the one whose name is exactly that file's, and its checksum is 64 hex digits.
checked() {
  want=$(tr -d '\r' < "${stage}/sums" | awk -v f="$1" '$2 == f && length($1) == 64 && $1 !~ /[^0-9a-f]/ { print $1; exit }')
  have=$(sha "$2")
  if [ -z "${want}" ] || [ "${want}" != "${have}" ]; then
    say "The download of $1 does not match its published checksum. Nothing was installed." >&2
    exit 1
  fi
}
if [ "${led}" = 1 ]; then printf '\n  \033[1mit\033[0m\033[32m.\033[0m  \033[2minstall\033[0m\n\n'
else say "It is being downloaded for ${os} ${arch}."
fi
fetch "${FROM}/SHA256SUMS" "${stage}/sums"
fetch "${FROM}/${name}" "${stage}/program"
checked "${name}" "${stage}/program"
fetch "${FROM}/LICENSE.md" "${stage}/license"
checked LICENSE.md "${stage}/license"
fetch "${FROM}/THIRD_PARTY_NOTICES.md" "${stage}/notices"
checked THIRD_PARTY_NOTICES.md "${stage}/notices"
chmod 755 "${stage}/program"
# A program that cannot start on this system is not installed: one built for another system's
# libraries, or for a chip this is not. It is started with a folder of its own to keep anything
# in, which goes when the folder made for this run does.
tried=0
IT_HOME="${stage}" "${stage}/program" --version < /dev/null > /dev/null 2> "${stage}/why" || tried=$?
if [ "${tried}" != 0 ]; then
  say "The program for ${os} ${arch} does not start on this system. Nothing was installed." >&2
  # And why, as far as the system or the program said: left out, a system without the loader
  # the program asks for, a folder that programs may not be run from and a chip that is too
  # old all read alike, and none of them says what to do.
  case "${tried}" in
    126) say "This system would not run it: programs may not be run from ${HOME_DIR}, as on a disk mounted noexec, or a security policy of this system refused it." >&2 ;;
    127) say "This system does not have what the program needs in order to start. That is so where the usual C library and its loader are not where programs look for them, as on Alpine and on NixOS." >&2 ;;
    132) say "The program used an instruction that this machine's chip does not have." >&2 ;;
  esac
  why="$(head -c 600 "${stage}/why" 2>/dev/null | tr -cd '\11\12\40-\176' | head -n 4)"
  if [ -n "${why}" ]; then say "What was said as it was tried: ${why}" >&2; fi
  exit 1
fi
if [ "${led}" = 1 ]; then did "Downloaded for ${os} ${arch}, and checked"; fi

# From here until the lock is given up, a signal does not stop this. Taking the lock and
# noting that it was taken are two steps, and stopped between them it would leave a lock that
# nothing removes; and once the replacing has begun, the only way to leave one release's files
# together is to finish it, or to put back what was there, and neither is to be cut short. The
# signal is taken and nothing is done about it, which is not the same as being deaf to it: a
# command started by a shell that is deaf to a signal is deaf to it too, and one that was
# moving a file and had stuck could then not be stopped. As it is, a signal sent to everything
# this started stops that command, and what was there is put back.
trap ':' HUP INT QUIT PIPE TERM
# A lock is taken from the install that holds it only when that install has stopped running:
# when the lock names a process on this machine, and no such process is there. However old a
# lock is, one whose process is running is left alone, and so is one held on another machine,
# and one that names nobody, which was made this moment or by an install that was killed as it
# made it. Only one install at a time may take a lock over, and it reads who holds the lock
# once it is that one, so that a lock just taken over by one install is never taken from it by
# the next.
if ! mkdir "${lock}" 2>/dev/null; then
  if mkdir "${lock}.taking" 2>/dev/null; then
    holder
    if [ -n "${by}" ] && [ "${on}" = "${here}" ] && ! running "${by}"; then
      rm -f -- "${lock}/owner" 2>/dev/null || true
      if rmdir "${lock}" 2>/dev/null && mkdir "${lock}" 2>/dev/null; then took=1; fi
    fi
    rmdir "${lock}.taking" 2>/dev/null || true
  fi
  if [ "${took}" = 0 ]; then
    holder
    if [ -n "${by}" ]; then who=", process ${by} on ${on},"; else who=""; fi
    say "Another install of It${who} is putting its files in ${HOME_DIR}. Run this again when it has finished. A lock is taken over by itself only once the process it names is gone from this machine. If no install of It is running, remove the folder ${lock} and, if it is there, the folder ${lock}.taking first." >&2
    exit 1
  fi
fi
if ! say "${me}" 2>/dev/null > "${lock}/owner"; then
  rmdir "${lock}" 2>/dev/null || true
  say "The lock ${lock} could not be written. Nothing was installed." >&2
  exit 1
fi
locked=1
# A link where a file is to go is moved aside like anything else and the file put in its place:
# nothing is written through a link to wherever it leads, and a link to a folder is not a way
# into that folder.
replacing=1
replace program "${DIR}/it"
replace license "${HOME_DIR}/LICENSE.md"
replace notices "${HOME_DIR}/THIRD_PARTY_NOTICES.md"
replacing=0
unlock
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 141' PIPE
trap 'exit 143' TERM

it_quoted=$(quoted "${DIR}/it")
if [ "${led}" = 1 ]; then did "Installed in ${DIR}"; fi

# Where this was downloaded from is noted for the program when it was not the usual place: it
# looks there for a newer It, and is updated from there. Asked later, from another terminal,
# it would not know, and would turn to the usual place for both. And a note left by an earlier
# install from another place is taken away by one from the usual place, which would otherwise
# go on looking where it was first installed from. A place whose address could not be written
# into the note as it stands is not noted, and neither is anything said to be.
noted="${BASE%/}"
case "${noted}" in
  https://itcan.do/releases) rm -f -- "${HOME_DIR}/releases.json" 2>/dev/null || true ;;
  *'"'* | *'\'* | *"
"*) : ;;
  *)
    if ! { (umask 077; printf '{"base":"%s"}\n' "${noted}" > "${HOME_DIR}/releases.json.$$") 2>/dev/null && mv -f -- "${HOME_DIR}/releases.json.$$" "${HOME_DIR}/releases.json" 2>/dev/null; }; then
      rm -f -- "${HOME_DIR}/releases.json.$$" 2>/dev/null || true
      say "Where this was downloaded from could not be noted in ${HOME_DIR}, so It will look for a newer version where it looked before, and not at ${noted}." >&2 || true
    fi
    ;;
esac

# The folder is put on the PATH by one line in the file the person's shell reads when it
# starts. Which file that is depends on the shell, and it is made if it is not there. The line
# is recognised again by being exactly this line, so installing twice adds it once.
changed=""
refused=""
# Adds the line to the file $1, which is called $2 when saying what was done
add_line() {
  if [ -f "$1" ] && grep -qxF -e "${line}" -- "$1" 2>/dev/null; then return 0; fi
  # A profile that is a link is written through, to the file it leads to: someone who keeps
  # their shell's files elsewhere and links to them wants the line where the link leads.
  # Errors are sent nowhere before the file is opened, so that a file that cannot be opened is
  # said once, below, and not also in the shell's own words
  if printf '\n# It\n%s\n' "${line}" 2>/dev/null >> "$1"; then changed="${changed} $2"; else refused="${refused} $2"; fi
}
# Calls $1 with each file this person's shell reads when it starts, and with what the file is
# called when saying what was done
each_profile() {
  case "$(basename -- "${SHELL:-sh}")" in
    # zsh keeps its files in the folder ZDOTDIR names, and in the home folder when it names none
    zsh)
      if [ -n "${ZDOTDIR:-}" ]; then "$1" "${ZDOTDIR}/.zshrc" "${ZDOTDIR}/.zshrc"
      else "$1" "${HOME}/.zshrc" "~/.zshrc"
      fi
      ;;
    # bash reads .bashrc, except when it is started as a login shell: then it reads the first
    # of these three that is there, and no other
    bash)
      if [ -f "${HOME}/.bash_profile" ]; then login=".bash_profile"
      elif [ -f "${HOME}/.bash_login" ]; then login=".bash_login"
      else login=".profile"
      fi
      "$1" "${HOME}/.bashrc" "~/.bashrc"
      "$1" "${HOME}/${login}" "~/${login}"
      ;;
    # fish reads none of those, and keeps what it runs when it starts in a folder of files
    # of its own: It's line goes in one that is It's alone
    fish)
      fish_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/fish/conf.d"
      if [ "$1" = add_line ]; then mkdir -p -- "${fish_dir}" 2>/dev/null || true; fi
      "$1" "${fish_dir}/it.fish" "${fish_dir}/it.fish"
      ;;
    *) "$1" "${HOME}/.profile" "~/.profile" ;;
  esac
}
# A word as fish reads it between single quotes, where only the quote and the backslash are marked
fish_quoted() { printf "'%s'" "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")"; }
on_path=0
case ":${PATH:-}:" in *":${DIR}:"*) on_path=1 ;; esac
# A terminal that has the folder on its PATH may be the only one that will: the terminal
# `it uninstall` was run in keeps the PATH it had, after the line that gave it was taken out of
# the shell's files. Installing again there, It would be found in that terminal and in no new
# one, nor by any agent. So where none of those files names the folder, the line is added as
# it is when the folder is on no PATH. Where one names it, the person put it on their PATH
# themselves, and their files are left as they are.
named=0
names_it() { if [ -f "$1" ] && grep -qF -e "${DIR}" -- "$1" 2>/dev/null; then named=1; fi; }
if [ "${on_path}" = 1 ] && [ -n "${HOME:-}" ]; then each_profile names_it; else named=1; fi
if [ -z "${IT_INSTALL_NO_PATH:-}" ] && { [ "${on_path}" = 0 ] || [ "${named}" = 0 ]; }; then
  if [ -z "${HOME:-}" ]; then
    if [ "${led}" = 1 ]; then mind "HOME is not set, so your PATH was left alone. Add ${DIR} to it yourself."
    else say "HOME is not set, so your PATH was left alone. Add ${DIR} to it yourself."
    fi
  else
    case "$(basename -- "${SHELL:-sh}")" in
      # In fish's own words, which are not the other shells': put first on the PATH unless it is on it
      fish) line="contains -- $(fish_quoted "${DIR}") \$PATH; or set -gx PATH $(fish_quoted "${DIR}") \$PATH" ;;
      *) line="export PATH=$(quoted "${DIR}"):\"\$PATH\"" ;;
    esac
    each_profile add_line
    # Where one file was changed and another could not be, a new terminal has the folder on
    # its PATH only if it reads the one that was changed, and so none is promised
    if [ "${led}" = 1 ]; then
      if [ -n "${changed}" ] && [ -n "${refused}" ]; then mind "On your PATH in${changed}, but${refused} could not be changed. Add this line there:  ${line}"
      elif [ -n "${changed}" ]; then did "On your PATH from the next terminal (${changed# })"
      elif [ -n "${refused}" ]; then mind "Your PATH could not be changed. Add ${DIR} to it yourself:  ${line}"
      else did "On your PATH from the next terminal"
      fi
    elif [ -n "${changed}" ] && [ -n "${refused}" ]; then say "Added ${DIR} to your PATH, in${changed}, but${refused} could not be changed, and a terminal that reads that file will not find It until the line is in it. Add it there yourself, or run:  ${line}"
    elif [ -n "${changed}" ]; then say "Added ${DIR} to your PATH, in${changed}. Open a new terminal, or run:  ${line}"
    elif [ -n "${refused}" ]; then say "Your PATH could not be changed. Add ${DIR} to it yourself:  ${line}"
    else say "${DIR} is already on the PATH of every new terminal. To use it in this one, run:  ${line}"
    fi
  fi
fi

# Nothing is said here of the usage counts It reports. The program says that itself, once, at
# the first command a person runs at a terminal, which the setup is, and records nothing before
# it has. So this leaves no note that it was said.
# Asked to join an It on another computer, the program does that now, and nothing is set up
# here. What the person types is read from the terminal itself where there is one, since this
# script was read from a pipe, and from nowhere where there is none: left the pipe, the program
# would read what is left of this script as an answer. The folder is on the PATH of the
# joining, as it will be in every terminal opened from now on, and what was downloaded into is
# cleared first: the joining may be at work for as long as the person takes.
if [ "${join}" = 1 ]; then
  if [ "${led}" = 1 ]; then quietly "Source-available under the It License, which is in ${HOME_DIR}/LICENSE.md."
  else say "It is source-available software under the It License, which is in ${HOME_DIR}/LICENSE.md."
  fi
  if [ -n "${stage}" ]; then rm -rf -- "${stage}" || true; stage=""; fi
  if [ "${led}" = 1 ] && ( : < /dev/tty ) 2>/dev/null; then
    printf '\n'
    IT_INSTALL_ON_PATH="${on_path}" PATH="${DIR}:${PATH:-}" "${DIR}/it" "$@" < /dev/tty || exit $?
  else
    IT_INSTALL_ON_PATH="${on_path}" PATH="${DIR}:${PATH:-}" "${DIR}/it" "$@" < /dev/null || exit $?
  fi
  exit 0
fi
OLD_LIBC="It cannot run on this system: the backend program it runs needs version 2.35 of the system's C library (glibc), which Ubuntu 22.04, Debian 12 and Fedora 36 have, and this system has ${old_libc}. The \`it\` command itself works here, and \`it login\` joins an It that runs on another machine."
if [ "${led}" = 0 ]; then
  say "It is source-available software under the It License, which is in ${HOME_DIR}/LICENSE.md."
  # Set apart from what came before it, so that how it ended and what to do next are the last things read
  say ""
  if [ -n "${old_libc}" ]; then
    say "It is installed. ${OLD_LIBC}"
    exit 0
  fi
  say "It is installed. Start it, and connect your agents, with:"
  say ""
  say "  ${it_quoted} setup"
  exit 0
fi
quietly "Source-available under the It License, which is in ${HOME_DIR}/LICENSE.md."
# Where It cannot run, no setup follows: it would only come to the same end, a few steps on
if [ -n "${old_libc}" ]; then
  mind "${OLD_LIBC}"
  exit 0
fi
# The setup follows at once, led by the program. This script was read from a pipe, so what the
# person types is read from the terminal itself. The folder is on the PATH of the setup, as it
# will be in every terminal opened from now on, and what was downloaded into is cleared first:
# the setup may be at work for as long as the person takes.
if ( : < /dev/tty ) 2>/dev/null; then
  if [ -n "${stage}" ]; then rm -rf -- "${stage}" || true; stage=""; fi
  printf '\n'
  IT_INSTALL_FLOW=1 IT_INSTALL_ON_PATH="${on_path}" PATH="${DIR}:${PATH:-}" "${DIR}/it" setup < /dev/tty || exit $?
else
  printf '\n  Next:  %s setup\n\n' "${it_quoted}"
fi
}
