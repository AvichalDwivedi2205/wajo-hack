#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'Keynote review requires macOS. This is not a native validation result.' >&2
  exit 1
fi
review_root="$(cd "$(dirname "$0")" && pwd)"
test -d /Applications/Keynote.app
mkdir -p "$review_root/.build"
# Fixed build-time dictionary extraction, not runtime executable content.
/usr/bin/sdef /Applications/Keynote.app > "$review_root/.build/Keynote.sdef"
(cd "$review_root/.build" && /usr/bin/sdp -fh --basename Keynote Keynote.sdef)
review_recipe_sha="$(/usr/bin/shasum -a 256 "$review_root/ReviewHelper.m" | /usr/bin/awk '{print $1}')"
review_dictionary_sha="$(/usr/bin/shasum -a 256 "$review_root/.build/Keynote.sdef" | /usr/bin/awk '{print $1}')"
review_keynote_short="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Keynote.app/Contents/Info.plist)"
review_keynote_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' /Applications/Keynote.app/Contents/Info.plist)"
review_keynote_version="$review_keynote_short+$review_keynote_build"
[[ "$review_keynote_version" =~ ^[A-Za-z0-9.+_-]{1,60}$ ]]
/usr/bin/clang -fobjc-arc -O2 -I "$review_root/.build" "-DREVIEW_RECIPE_SHA=\"$review_recipe_sha\"" "-DREVIEW_DICTIONARY_SHA=\"$review_dictionary_sha\"" "-DREVIEW_KEYNOTE_VERSION=\"$review_keynote_version\"" -framework Foundation -framework AppKit -framework ScriptingBridge -framework PDFKit -framework ApplicationServices "$review_root/ReviewHelper.m" -o "$review_root/.build/fo-review"
/usr/bin/shasum -a 256 "$review_root/.build/Keynote.sdef" "$review_root/ReviewHelper.m"
echo 'Built the fixed review helper. No application launched, permission requested or credential configured. Native acceptance is still required.'
