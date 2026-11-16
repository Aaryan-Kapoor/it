# Claude Code set up the guide's way, then `it setup --only codex` run as a person adding Codex
# would, to see what it does to Claude Code. The flow then tries Claude Code's clicks.
sh /build/harness/prep-setup.sh claude
echo "before: $(su -l ana -s /bin/bash -c '~/.it/bin/it status 2>&1' | tr -d '\n' | grep -o '"addon": "[a-z_]*", "id": "[a-z-]*"' | tr '\n' ' ')"
su -l ana -s /bin/bash -c '~/.it/bin/it setup --only codex 2>&1 | grep -iE "claude|codex|agent apps|disconnect|removed|out\b" | head -12'
echo "after: $(su -l ana -s /bin/bash -c '~/.it/bin/it status 2>&1' | tr -d '\n' | grep -o '"addon": "[a-z_]*", "id": "[a-z-]*"' | tr '\n' ' ')"
su -l ana -s /bin/bash -c 'ls ~/.claude/plugins 2>&1 | head -5; grep -o "\"it[^\"]*\": *true" ~/.claude/settings.json 2>/dev/null | head -3'
