#!/usr/bin/env python3
"""
Check rendered narration without listening to it.

    python tools/verify-audio.py                    # audio-kokoro, index.html
    python tools/verify-audio.py audio-qwen author.html

For every script in narration/ it checks that:
  * an mp3 exists and decodes
  * its length fits the script: words divided by minutes lands inside a spoken
    pace, which catches truncation, looping and a stalled engine
  * nothing clips, and the file is not silent
  * no gap of near-silence is longer than the longest deliberate pause
  * the durations in the page's AUDIO manifest match the files

Exit status is non-zero if anything fails.
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
PACE = (100, 205)        # words per minute; Kokoro at 0.9 lands near 170, a cloned voice near 125
MAX_GAP = 1.6            # seconds of near-silence; deliberate pauses are <= 0.85
MAX_GAP_CLONE = 2.6      # the cloned voice leaves longer natural pauses; the shipped chapters reach 2.4
SILENT = 0.004           # amplitude below which a 20 ms window counts as silence


def longest_gap(data, rate):
    win = int(rate * 0.02)
    n = len(data) // win
    if n == 0:
        return 0.0
    level = np.abs(data[: n * win]).reshape(n, win).max(axis=1)
    best = run = 0
    for quiet in level < SILENT:
        run = run + 1 if quiet else 0
        best = max(best, run)
    return best * 0.02


def manifest(page):
    html = (ROOT / page).read_text(encoding="utf-8")
    m = re.search(r'dir:\s*"([^"]+)"', html)
    tracks = dict((cid, float(d)) for cid, d in
                  re.findall(r'(ch\d+):\s*\{\s*f:\s*"[^"]+",\s*d:\s*([\d.]+)', html))
    return (m.group(1) if m else None), tracks


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "audio-kokoro"
    page = sys.argv[2] if len(sys.argv) > 2 else (
        "author.html" if "qwen" in folder else "index.html")
    out = ROOT / folder
    problems, total, size = [], 0.0, 0
    _dir, tracks = manifest(page)
    if _dir and _dir.rstrip("/") != folder.rstrip("/"):
        problems.append("%s points at %s, not %s" % (page, _dir, folder))

    for script in sorted((ROOT / "narration").glob("[0-9][0-9]-*.txt")):
        cid = "ch" + script.name[:2]
        mp3 = out / (cid + ".mp3")
        if not mp3.exists():
            problems.append("%s: no %s" % (cid, mp3.name))
            continue
        try:
            data, rate = sf.read(str(mp3), dtype="float32")
        except Exception as exc:
            problems.append("%s: does not decode (%s)" % (cid, exc))
            continue
        if data.ndim > 1:
            data = data.mean(axis=1)
        secs = len(data) / rate
        words = len(script.read_text(encoding="utf-8").split())
        wpm = words / (secs / 60)
        peak = float(np.abs(data).max())
        gap = longest_gap(data, rate)
        total += secs
        size += mp3.stat().st_size
        flags = []
        if not PACE[0] <= wpm <= PACE[1]:
            flags.append("pace %.0f wpm outside %d-%d" % (wpm, *PACE))
        if peak >= 0.99:
            flags.append("clips (peak %.3f)" % peak)
        if peak < 0.05:
            flags.append("nearly silent (peak %.3f)" % peak)
        if gap > (MAX_GAP_CLONE if "qwen" in folder else MAX_GAP):
            flags.append("silence of %.1f s" % gap)
        if cid not in tracks:
            flags.append("missing from the %s manifest" % page)
        elif abs(tracks[cid] - secs) > 0.5:
            flags.append("manifest says %.1f s, file is %.1f s" % (tracks[cid], secs))
        print("  %s  %5.1f s  %3.0f wpm  peak %.2f  gap %.2f s  %s"
              % (cid, secs, wpm, peak, gap, "; ".join(flags) or "ok"))
        problems += ["%s: %s" % (cid, f) for f in flags]
    for cid in sorted(set(tracks) - {"ch" + s.name[:2] for s in (ROOT / "narration").glob("[0-9][0-9]-*.txt")}):
        problems.append("%s is in the manifest but has no script" % cid)

    print("\n%s: %.1f min, %.1f MB" % (folder, total / 60, size / 1e6))
    for p in problems:
        print("  x", p)
    print("all good" if not problems else "%d problem(s)" % len(problems))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
