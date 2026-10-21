import re
import sys
from pathlib import Path


component_path = Path(sys.argv[1])
source = component_path.read_text(encoding="utf-8")
method_start = source.find("async onPlayingChanged(playing: boolean) {")
method_end = source.find("@Watch('clipboard')", method_start)
if method_start < 0 or method_end < 0:
    raise SystemExit(f"Could not locate the Neko playback handler in {component_path}")

method = source[method_start:method_end]
method, replacements = re.subn(
    r"(?m)^([ \t]*)await this\._video\.play\(\)",
    lambda match: (
        match.group(0)
        + "\n"
        + match.group(1)
        + "if (new URLSearchParams(window.location.search).get('autounmute') === '1') {\n"
        + match.group(1)
        + "  this.$accessor.video.setMuted(false)\n"
        + match.group(1)
        + "  this.mutedOverlay = false\n"
        + match.group(1)
        + "}"
    ),
    method,
    count=1,
)
if replacements != 1:
    raise SystemExit(f"Expected to patch the initial Neko play attempt once, patched {replacements}")

source = source[:method_start] + method + source[method_end:]
component_path.write_text(source, encoding="utf-8")
print("Patched Neko to unmute only after its initial playback attempt succeeds")
