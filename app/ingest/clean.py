"""Split an email body into the parts that matter: the sender's own message
vs. external-sender banners, signatures and quoted/forwarded threads."""
import re
from dataclasses import dataclass

BANNER_RE = re.compile(
    r"^\s*(warning|caution|external( email| sender)?)\s*[:\-!].{0,300}?"
    r"(attachments?|links?|sender|content)\s*\.?\s*$",
    re.I | re.M | re.S)
BANNER_LINE_RE = re.compile(
    r"^.*(originated (from )?outside|external (e-?mail|sender)|exercise caution|"
    r"do not click (on )?links).*$", re.I | re.M)

QUOTE_START_RE = re.compile(
    r"^\s*(_{5,}|-{5,}\s*(original|forwarded) message\s*-{0,}|"
    r"from:\s.+|on .{5,80} wrote:|-{2,}\s*forwarded.*)\s*$", re.I | re.M)

SIGNOFF_RE = re.compile(
    r"^\s*(best regards|kind regards|warm regards|regards|best|thanks(?: and regards)?|"
    r"thank you(?: and regards)?|sincerely|cheers|rgds|br)\s*[,.!]?\s*$", re.I | re.M)
SIG_DASH_RE = re.compile(r"^\s*--\s.*$", re.M)
GREETING_RE = re.compile(r"^\s*(hi|dear|hello|good (morning|afternoon|day))\b[^\n]{0,60}\n", re.I)


@dataclass
class CleanBody:
    message: str      # what the sender actually wrote this time
    signature: str
    quoted: str       # forwarded / replied thread
    banner: str


def clean_body(body: str) -> CleanBody:
    text = (body or "").replace("\r\n", "\n")
    banner = ""
    m = BANNER_LINE_RE.search(text[:600])
    if m:
        banner = m.group(0).strip()
        text = text[:m.start()] + text[m.end():]

    quoted = ""
    q = QUOTE_START_RE.search(text)
    if q:
        quoted = text[q.start():].strip()
        text = text[:q.start()]

    signature = ""
    # "Thank you." inside the message is not a sign-off unless it is the last
    # thing before a name block, so take the LAST sign-off candidate that still
    # leaves some message above it.
    cands = [s for s in SIGNOFF_RE.finditer(text)] + [s for s in SIG_DASH_RE.finditer(text)]
    cands = [s for s in cands if text[:s.start()].strip()]
    if cands:
        first = min(cands, key=lambda s: s.start())
        signature = text[first.start():].strip()
        text = text[:first.start()]

    message = GREETING_RE.sub("", text.strip(), count=1).strip()
    return CleanBody(message=message, signature=signature, quoted=quoted, banner=banner)
