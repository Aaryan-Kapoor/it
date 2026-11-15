#!/bin/sh
# The eyes and hands of the person in one rehearsal run, and nothing more. A model that plays the
# person uses this command alone: it sees the whole screen of the machine as a picture and acts
# on it with the mouse and the keyboard, as a person at that laptop would.
#
#   person look                      a picture of the whole screen, 1280 by 720; prints its file
#   person click X Y                 a left click at that point of the picture
#   person double X Y                a double click
#   person right X Y                 a right click
#   person ctrlclick X Y             a click with Ctrl held, which opens a link in the terminal
#   person drag X1 Y1 X2 Y2 [X3 Y3 ...]  press at the first point, move through the others, let go
#   person scroll X Y up|down [N]    the mouse wheel, N notches (3 if not given)
#   person type "text"               types the text where the keyboard is
#   person key NAME                  one key or chord: Return, Tab, Escape, Up, Down, BackSpace, ctrl+c ...
#   person wait SECONDS              waits, up to 120 seconds at a time
#   person say "words"               one line of what the person is thinking, kept with the time
#   person done "words"              the person's own account at the end
#
# Points are in the pixels of the picture `look` gives. The run it acts on is the one named in
# $PERSON_RUN, a folder that run.mjs made, which holds the name of the machine.
set -eu
run="${PERSON_RUN:?PERSON_RUN names the run}"
[ -f "$run/ready" ] || { echo "The machine is not ready yet."; exit 1; }
box=$(cat "$run/ready")
case "$box" in it-rehearsal-*) ;; *) echo "Not a rehearsal machine."; exit 1 ;; esac
t0=$(cat "$run/t0")
now() { echo $(( $(date +%s) - t0 )); }
clock() { s=$(now); printf '%02d:%02d' $((s / 60)) $((s % 60)); }
note() { printf '{"t":%s,"do":"%s"}\n' "$(now)" "$1" >> "$run/actions.jsonl"; }
x() { sudo -n docker exec -u ana -e DISPLAY=:1 "$box" xdotool "$@"; }
num() { case "$1" in ''|*[!0-9]*) echo "Give whole numbers for points."; exit 2 ;; esac; }
big() { echo $(( $1 * 3 / 2 )); }
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  look)
    n=$(ls "$run/shots" 2>/dev/null | wc -l)
    mkdir -p "$run/shots"
    f="$run/shots/$(printf '%04d' $((n + 1)))-$(clock | tr : -).png"
    sudo -n docker exec "$box" sh -c 'ffmpeg -loglevel error -y -f x11grab -video_size 1920x1080 -i :1 -frames:v 1 -vf scale=1280:720 /var/lib/rehearsal-video/look.png' \
      && sudo -n docker cp "$box:/var/lib/rehearsal-video/look.png" "$f" >/dev/null
    note "look"
    echo "$f"
    ;;
  click|double|right|ctrlclick)
    num "${1:-}"; num "${2:-}"
    X=$(big "$1"); Y=$(big "$2")
    case "$cmd" in
      click) x mousemove "$X" "$Y" sleep 0.15 click 1 ;;
      double) x mousemove "$X" "$Y" sleep 0.15 click --repeat 2 --delay 120 1 ;;
      right) x mousemove "$X" "$Y" sleep 0.15 click 3 ;;
      ctrlclick) x mousemove "$X" "$Y" sleep 0.15 keydown ctrl click 1 keyup ctrl ;;
    esac
    note "$cmd $1 $2"; sleep 0.8; echo "done"
    ;;
  drag)
    [ $# -ge 4 ] || { echo "Give at least two points."; exit 2; }
    for v in "$@"; do num "$v"; done
    X=$(big "$1"); Y=$(big "$2"); shift 2
    args="mousemove $X $Y sleep 0.2 mousedown 1"
    px=$X; py=$Y
    while [ $# -ge 2 ]; do
      nx=$(big "$1"); ny=$(big "$2"); shift 2
      i=1
      while [ $i -le 12 ]; do
        args="$args mousemove $(( px + (nx - px) * i / 12 )) $(( py + (ny - py) * i / 12 )) sleep 0.02"
        i=$((i + 1))
      done
      px=$nx; py=$ny
    done
    # shellcheck disable=SC2086
    x $args sleep 0.2 mouseup 1
    note "drag"; sleep 0.8; echo "done"
    ;;
  scroll)
    num "${1:-}"; num "${2:-}"
    b=5; [ "${3:-down}" = up ] && b=4
    x mousemove "$(big "$1")" "$(big "$2")" click --repeat "${4:-3}" --delay 80 "$b"
    note "scroll ${3:-down}"; sleep 0.6; echo "done"
    ;;
  type)
    x type --delay 45 -- "${1:-}"
    note "type"; sleep 0.8; echo "done"
    ;;
  key)
    case "${1:-}" in ''|*[!A-Za-z0-9_+]*) echo "Name one key, such as Return or ctrl+c."; exit 2 ;; esac
    x key -- "$1"
    note "key $1"; sleep 0.8; echo "done"
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
    sed -n '2,24p' "$0"
    ;;
esac
