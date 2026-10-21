from pathlib import Path


assets = Path("/var/www/js")
old = "if(e>=600&&s>=300)"
new = (
    "if((e===3840&&s===2160)||(e===2560&&s===1440)"
    "||(e===1920&&s===1080)||(e===1280&&s===720)"
    "||(e===854&&s===480))"
)

patched = 0
for bundle in assets.glob("app*.js"):
    source = bundle.read_text(encoding="utf-8")
    if old in source:
        bundle.write_text(source.replace(old, new), encoding="utf-8")
        patched += 1

if not patched:
    raise SystemExit(f"Could not find Neko resolution filter in {assets}/app*.js")

print(f"Restricted Neko resolution choices in {patched} client bundle(s)")
