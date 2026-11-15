#!/bin/sh
# The eyes and hands of the person in one Mac rehearsal run, and nothing more. A model that plays
# the person uses this command alone: it sees the Mac's whole screen as a picture and acts on it
# with the mouse and the keyboard, as a person at that laptop would.
#
#   person look                      a picture of the whole screen, 1280 pixels wide; prints its file
#   person click X Y                 a left click at that point of the picture
#   person double X Y                a double click
#   person right X Y                 a right click
#   person drag X1 Y1 X2 Y2 [X3 Y3 ...]  press at the first point, move through the others, let go
#   person scroll X Y up|down [N]    the mouse wheel, N notches (3 if not given)
#   person type "text"               types the text where the keyboard is
#   person key NAME                  one key or chord: Return, Tab, Escape, Up, Down, Backspace,
#                                    cmd+v, ctrl+c ...
#   person wait SECONDS              waits, up to 120 seconds at a time
#   person say "words"               one line of what the person is thinking, kept with the time
#   person done "words"              the person's own account at the end
#
# Points are in the pixels of the picture `look` gives. The run it acts on is the folder this
# copy of the script sits in (run.mjs puts one in each run), which names the Mac.
set -eu
run=$(cd "$(dirname "$0")" && pwd)
NSC=/tmp/claude-1000/-home-cbak-programming-it/51f6f360-74f1-48c2-9f53-3ca473781de1/scratchpad/nsc/bin/nsc
[ -f "$run/ready" ] || { echo "The machine is not ready yet."; exit 1; }
mac=$(cat "$run/ready")
case "$mac" in *[!a-z0-9]*|'') echo "Not a rehearsal Mac."; exit 1 ;; esac
[ -f "$run/finished" ] && { echo "The run is over."; exit 1; }
t0=$(cat "$run/t0")
now() { echo $(( $(date +%s) - t0 )); }
clock() { s=$(now); printf '%02d:%02d' $((s / 60)) $((s % 60)); }
note() { printf '{"t":%s,"do":"%s"}\n' "$(now)" "$1" >> "$run/actions.jsonl"; }
GUI='sudo launchctl asuser 501 sudo -u runner -H'
hands() { "$NSC" ssh -T "$mac" "$GUI /usr/local/bin/hands $*" </dev/null; }
num() { case "$1" in ''|*[!0-9]*) echo "Give whole numbers for points."; exit 2 ;; esac; }
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  look)
    mkdir -p "$run/shots"
    n=$(ls "$run/shots" | wc -l)
    f="$run/shots/$(printf '%04d' $((n + 1)))-$(clock | tr : -).png"
    "$NSC" ssh -T "$mac" "$GUI screencapture -x -C -t png /Users/Shared/rehearsal/look.png && sips -Z 1280 /Users/Shared/rehearsal/look.png --out /Users/Shared/rehearsal/look-s.png >/dev/null && cat /Users/Shared/rehearsal/look-s.png" </dev/null > "$f.part"
    if [ -s "$f.part" ]; then mv "$f.part" "$f"; else rm -f "$f.part"; echo "The screen could not be seen; try again."; exit 1; fi
    note "look"
    echo "$f"
    ;;
  click|double|right)
    num "${1:-}"; num "${2:-}"
    hands "$cmd" "$1" "$2"
    note "$cmd $1 $2"; sleep 0.5; echo "done"
    ;;
  drag)
    [ $# -ge 4 ] || { echo "Give at least two points."; exit 2; }
    for v in "$@"; do num "$v"; done
    hands drag "$@"
    note "drag $*"; sleep 0.5; echo "done"
    ;;
  scroll)
    num "${1:-}"; num "${2:-}"
    dir=down; [ "${3:-down}" = up ] && dir=up
    n=${4:-3}; num "$n"
    hands scroll "$1" "$2" "$dir" "$n"
    note "scroll $dir"; sleep 0.4; echo "done"
    ;;
  type)
    printf '%s' "${1:-}" | "$NSC" ssh -T "$mac" "$GUI /usr/local/bin/hands type -"
    note "type"; sleep 0.4; echo "done"
    ;;
  key)
    case "${1:-}" in ''|*[!A-Za-z0-9_+]*) echo "Name one key, such as Return or cmd+v."; exit 2 ;; esac
    hands key "$1"
    note "key $1"; sleep 0.4; echo "done"
    ;;
  wait)
    num "${1:-}"; s=$1; [ "$s" -gt 120 ] && s=120
    sleep "$s"; echo "waited $s seconds"
    ;;
  say)
    printf '[%s] %s\n' "$(clock)" "${1:-}" >> "$run/person-log.txt"; echo "noted"
    ;;
  done)
    printf '[%s] %s\n' "$(clock)" "${1:-}" >> "$run/person-account.txt"; touch "$run/person-done"; echo "noted"
    ;;
  *)
    sed -n '2,20p' "$0"
    ;;
esac
