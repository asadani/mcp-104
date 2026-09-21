#!/usr/bin/env python3
"""
Check the narration scripts before they are rendered.

    python tools/lint-narration.py

Audio cannot be proofread after the fact, so the text has to be right first.
This catches what a listener would hear as a fault:

  * a script per chapter on the page, numbered to match, and no strays
  * an opening line that says the right chapter number
  * a sensible length (too short is a stub, too long is a lecture)
  * characters that do not read aloud: digits, backticks, slashes, brackets,
    identifiers such as camelCase or snake_case, and web addresses
  * initialisms the pronunciation tables do not know about

Exit status is non-zero if anything is found, so it can gate a render.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NARRATION = ROOT / "narration"
GENERATOR = ROOT / "tools" / "generate-audio.py"

NUMBER_WORDS = ("zero one two three four five six seven eight nine ten eleven twelve "
                "thirteen fourteen fifteen sixteen seventeen eighteen nineteen").split()
TENS = {20: "twenty", 30: "thirty", 40: "forty"}

# Plain-form initialisms and names the generator's SPOKEN_ACRONYMS handles, plus
# ones an engine says correctly without help.
PLAIN_OK = {"MCP", "API", "APIs", "JSON", "HTTP", "HTTPS", "URL", "URLs", "URI", "URIs",
            "REST", "AI", "LLM", "AWS", "CORS", "USB", "ODBC", "HMAC", "OS", "DNS", "GPU",
            "HTML", "OAuth", "PGlite", "S3", "RPC", "ISO", "GET", "POST", "PUT",
            "PATCH", "DELETE", "JSON-RPC", "TypeScript", "JavaScript", "Zod", "Kokoro"}

MIN_WORDS, MAX_WORDS = 90, 520


def chapter_word(n):
    if n < 20:
        return NUMBER_WORDS[n]
    tens, ones = (n // 10) * 10, n % 10
    return TENS[tens] + ("-" + NUMBER_WORDS[ones] if ones else "")


def known_dotted():
    text = GENERATOR.read_text(encoding="utf-8")
    block = text[text.index("DOTTED = ["):]
    block = block[:block.index("\n]")]
    return set(re.findall(r'\("([A-Z](?:\.[A-Z])+\.s?)"', block))


def page_chapters():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    return sorted(set(int(n) for n in re.findall(r'<section class="chapter" id="ch(\d+)"', html)))


def main():
    problems = []
    dotted_ok = known_dotted()
    scripts = sorted(NARRATION.glob("[0-9][0-9]-*.txt"))
    have = {int(p.name[:2]) for p in scripts}
    want = set(page_chapters())
    for n in sorted(want - have):
        problems.append("ch%02d: the page has this chapter but there is no script" % n)
    for n in sorted(have - want):
        problems.append("ch%02d: a script exists but the page has no such chapter" % n)

    for path in scripts:
        n = int(path.name[:2])
        text = path.read_text(encoding="utf-8")
        lines = text.split("\n")
        tag = path.name

        want_open = "Chapter %s." % chapter_word(n)
        if not lines[0].startswith(want_open):
            problems.append("%s: first line should start %r, got %r" % (tag, want_open, lines[0][:40]))
        if len(lines) < 3 or lines[1].strip():
            problems.append("%s: the opening line must be followed by a blank line" % tag)

        words = len(text.split())
        if not MIN_WORDS <= words <= MAX_WORDS:
            problems.append("%s: %d words, expected %d to %d" % (tag, words, MIN_WORDS, MAX_WORDS))

        for ln, line in enumerate(lines, 1):
            line = line.replace("S3", "ess")   # the tables say it as 'ess three'
            for pattern, why in [
                (r"\d", "a digit; write the number as words"),
                (r"[`_{}<>=#*|\\@$%^~\[\]]", "a symbol that does not read aloud"),
                (r"/", "a slash; say 'or', 'and', or spell the path out"),
                (r"https?:|www\.", "a web address"),
                (r"\b[a-z]+[A-Z][A-Za-z]*\b", "an identifier in camelCase"),
                (r"  +", "a double space"),
            ]:
                m = re.search(pattern, line)
                if m:
                    problems.append("%s:%d: %s (%r)" % (tag, ln, why, line[max(0, m.start() - 12):m.end() + 12]))

        for tok in re.findall(r"\b(?:[A-Z]\.){2,}s?", text):
            if tok not in dotted_ok and tok.rstrip("s") not in dotted_ok:
                problems.append("%s: dotted initialism %s is not in the DOTTED table" % (tag, tok))
        for tok in set(re.findall(r"\b[A-Z]{2,}[a-z]?\b", text)):
            if tok not in PLAIN_OK:
                problems.append("%s: %s is not a known plain initialism; dot it or add it to the tables" % (tag, tok))
        for tok in re.findall(r"\b(?:M\.C\.P\.|A\.P\.I\.|H\.T\.T\.P\.|J\.S\.O\.N\.|U\.R\.L\.)", text):
            problems.append("%s: write %s without dots; the generator handles the plain form" % (tag, tok))

    total = sum(len(p.read_text(encoding="utf-8").split()) for p in scripts)
    print("%d scripts, %d words, about %.0f minutes at 170 wpm" % (len(scripts), total, total / 170))
    for p in problems:
        print("  x", p)
    print("clean" if not problems else "%d problem(s)" % len(problems))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
