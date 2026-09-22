"""Regular expressions typed by users (auto-tag rules, knowledge-base classifier hints) are
run on the server, so they are treated as hostile input: a pattern like (.+)+Z against an email
body never returns with Python's built-in `re`, which has no timeout.

Two layers:
  1. refuse the obviously catastrophic SHAPES when the rule is saved, so the person typing it
     gets an explanation instead of a rule that silently never matches;
  2. bound the WORK as a backstop: patterns run on the `regex` engine with a timeout, on at most
     6000 characters, and a pattern that keeps timing out is given up on (3 strikes), so it cannot
     cost its timeout once per case in the inbox.
"""
import re
from functools import lru_cache

try:                                    # `regex` supports search(timeout=...); fall back to shape checks only
    import regex as _engine
    _HAS_TIMEOUT = True
except ImportError:                     # pragma: no cover
    _engine = re
    _HAS_TIMEOUT = False

MAX_PATTERN = 160
MAX_TEXT = 6000
# The engine's timeout clock is not "time spent on this pattern": on Linux it is the process's CPU time across
# ALL threads (on Windows, wall time), so other busy threads eat into it. At 50 ms a trivial pattern timed out
# whenever the pipeline's workers were busy, and the rule was then disabled for good (the seed lost 124 of 127
# "External sender" tags). It is only a backstop - catastrophic shapes are refused at save time - so it is
# generous, and a pattern is only given up on after repeated timeouts.
TIMEOUT_S = 2.0
STRIKES = 3

_QUANT = r"(?:[+*]|\{\d+(?:,\d*)?\}|\{,\d+\})"
# a group "( ... )" whose body contains + * {n,} or |, and that is itself repeated
_NESTED = re.compile(r"\((?:[^()\\]|\\.)*(?:[+*|]|\{\d*,)(?:[^()\\]|\\.)*\)\s*" + _QUANT)
_GROUP_IN_GROUP_REPEATED = re.compile(r"\((?:[^()\\]|\\.)*\((?:[^()\\]|\\.)*\)(?:[^()\\]|\\.)*\)\s*" + _QUANT)
_BACKREF = re.compile(r"\\[1-9]|\(\?P=")
_strikes: dict[str, int] = {}


def check_user_regex(pattern: str) -> str | None:
    """None when the pattern is acceptable, otherwise a message for the person who typed it."""
    if not isinstance(pattern, str) or not pattern.strip():
        return "the pattern is empty"
    if len(pattern) > MAX_PATTERN:
        return f"the pattern is longer than {MAX_PATTERN} characters"
    if _BACKREF.search(pattern):
        return "back-references are not allowed"
    if _NESTED.search(pattern) or _GROUP_IN_GROUP_REPEATED.search(pattern):
        return "a repeated group may not itself contain a repeat or an alternative, e.g. (a+)+ or (a|b)*"
    try:
        _engine.compile(pattern)
    except Exception as e:              # re.error / regex.error
        return f"not a valid regular expression: {e}"
    return None


@lru_cache(maxsize=512)
def _compiled(pattern: str):
    return None if check_user_regex(pattern) else _engine.compile(pattern, _engine.I)


def user_search(pattern: str, text: str) -> bool:
    """Search with a user-supplied pattern. Unsafe, invalid or too-slow patterns never match."""
    if _strikes.get(pattern, 0) >= STRIKES:
        return False
    rx = _compiled(pattern)
    if rx is None:
        return False
    text = (text or "")[:MAX_TEXT]
    if not _HAS_TIMEOUT:
        return bool(rx.search(text))
    try:
        # concurrent=True: the engine releases the GIL while it matches, so even a slow pattern
        # does not freeze the other visitors' requests in this single process
        return bool(rx.search(text, timeout=TIMEOUT_S, concurrent=True))
    except TimeoutError:
        _strikes[pattern] = _strikes.get(pattern, 0) + 1
        return False
