"""Value normalisers. Pure functions, unit-tested in tests/test_normalize.py."""
import re
import unicodedata

# ------------------------------------------------------------------ numbers
_NUM_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
}


def parse_number(text: str, dot_thousands: bool = True) -> float | None:
    """'131,058' '131.058,50' '131 058.5' '1.234.567' -> float.
    `dot_thousands`: read a lone '131.058' as 131058 (kg context) rather than 131.058."""
    m = re.search(r"\d[\d.,\s']*\d|\d", text or "")
    if not m:
        return None
    s = re.sub(r"[\s']", "", m.group(0))
    if "," in s and "." in s:
        # the right-most separator is the decimal one
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        s = s.replace(",", "") if all(len(p) == 3 for p in parts[1:]) else s.replace(",", ".")
    elif s.count(".") > 1 or (dot_thousands and s.count(".") == 1 and len(s.split(".")[1]) == 3
                              and len(s.split(".")[0]) <= 3 and float(s.replace(".", "")) >= 1000):
        # "131.058" in a weight context is a thousands separator far more often
        # than a 3-decimal number; "21.5" stays a decimal.
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


_UNIT_TO_KG = [
    (r"\b(kgs?|kilos?|kilograms?)\b", 1.0),
    (r"\b(mts?|m/t|tons?|tonnes?|metric\s+tons?)\b", 1000.0),
    (r"\b(lbs?|pounds?)\b", 0.45359237),
]


def parse_weight_kg(value: str, label: str = "") -> float | None:
    """Weight in kg. The unit may sit in the value ('21,577 KG') or only in the
    label ('Gross Weight (KG)')."""
    if value is None:
        return None
    tail = re.sub(r"[\d.,\s']+", " ", str(value), count=1)
    factor = None
    for src in (tail, label or ""):
        for rx, f in _UNIT_TO_KG:
            if re.search(rx, src, re.I):
                factor = f
                break
        if factor:
            break
    num = parse_number(str(value), dot_thousands=(factor or 1.0) == 1.0)
    if num is None:
        return None
    return round(num * (factor or 1.0), 3)


def parse_container_count(value: str) -> tuple[int | None, list[str]]:
    """'3 x 40HC' -> (3, ['40HC']); '2x20GP + 1x40HC' -> (3, [...]);
    'THREE (3) CONTAINERS' -> 3; '12' -> 12."""
    if value is None:
        return None, []
    s = str(value).upper().replace("×", "X").replace("*", "X")
    groups = re.findall(r"(\d{1,3})\s*X\s*(\d{2})\s*['’`]?\s*(?:FT|FEET|FOOT|FOOTER)?\s*([A-Z]{2,4})?", s)
    if groups:
        return sum(int(g[0]) for g in groups), [f"{g[1]}{g[2] or ''}" for g in groups]
    m = re.search(r"\((\d{1,3})\)", s)                      # THREE (3)
    if m:
        return int(m.group(1)), []
    m = re.search(r"\b(\d{1,3})\b(?!\s*['’]|\s*-?\s*(FT|FEET|FOOT|FOOTER|HC|HQ|GP|DV|RF|OT)\b)", s)   # plain count, not a size ("40 foot")
    if m:
        return int(m.group(1)), []
    total, found = 0, False
    for w in re.findall(r"[A-Z]+", s):
        if w.lower() in _NUM_WORDS:
            total += _NUM_WORDS[w.lower()]
            found = True
    return (total, []) if found else (None, [])


# ------------------------------------------------------------------ ports
_PORT_NOISE = re.compile(r"\b(PORT OF|SEAPORT|SEA PORT|HARBOU?R|TERMINAL|ANY PORT IN)\b")
# Seed variants; the knowledge base adds more at runtime (kind="port").
PORT_ALIASES = {
    "PORT KELANG": "PORT KLANG", "PORT KLANG": "PORT KLANG", "KLANG": "PORT KLANG", "PELABUHAN KLANG": "PORT KLANG",
    "PKG": "PORT KLANG", "WESTPORT": "PORT KLANG", "NORTHPORT": "PORT KLANG",
    "HOCHIMINH CITY": "HO CHI MINH", "HO CHI MINH CITY": "HO CHI MINH", "HOCHIMINH": "HO CHI MINH",
    "HCMC": "HO CHI MINH", "SAIGON": "HO CHI MINH", "CAT LAI": "HO CHI MINH",
    "NHAVA SHEVA": "NHAVA SHEVA", "NHAVASHEVA": "NHAVA SHEVA", "JNPT": "NHAVA SHEVA",
    "JAWAHARLAL NEHRU": "NHAVA SHEVA", "NAVA SHEVA": "NHAVA SHEVA",
    "BUSAN": "BUSAN", "PUSAN": "BUSAN", "JEBEL ALI": "JEBEL ALI", "JEBELALI": "JEBEL ALI",
    "TUTICORIN": "TUTICORIN", "THOOTHUKUDI": "TUTICORIN", "YANGON": "YANGON", "RANGOON": "YANGON",
    "LAEM CHABANG": "LAEM CHABANG", "LAEMCHABANG": "LAEM CHABANG",
    "TANJUNG PELEPAS": "TANJUNG PELEPAS", "PTP": "TANJUNG PELEPAS",
    "CHITTAGONG": "CHATTOGRAM", "CHATTOGRAM": "CHATTOGRAM", "CALCUTTA": "KOLKATA", "BOMBAY": "MUMBAI",
    "MADRAS": "CHENNAI", "PIRAEUS": "PIRAEUS", "PIREAUS": "PIRAEUS",
}
COUNTRY_ALIASES = {
    "USA": "US", "U S A": "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US",
    "UAE": "AE", "U A E": "AE", "UNITED ARAB EMIRATES": "AE", "UK": "GB", "UNITED KINGDOM": "GB",
    "KOREA": "SOUTH KOREA", "REPUBLIC OF KOREA": "SOUTH KOREA", "VIET NAM": "VIETNAM",
    "PRC": "CHINA", "P R CHINA": "CHINA", "PEOPLES REPUBLIC OF CHINA": "CHINA", "TURKIYE": "TURKEY",
}


def _ascii_upper(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return s.upper()


def normalise_port(value: str, extra_aliases: dict[str, str] | None = None) -> dict:
    """-> {"city", "country", "locode", "key"}; `key` is what gets compared."""
    raw = _ascii_upper(value or "")
    locode = None
    m = re.search(r"\(\s*([A-Z]{2}\s?[A-Z0-9]{3})\s*\)", raw)
    if m:
        locode = m.group(1).replace(" ", "")
    s = re.sub(r"\([^)]*\)", " ", raw)                       # (WESTPORT), (MYPKG)
    parts = [re.sub(r"[^A-Z0-9/ ]+", " ", p).strip() for p in s.split(",")]
    parts = [re.sub(r"\s+", " ", p) for p in parts if p.strip()]
    city = parts[0] if parts else ""
    country = parts[-1] if len(parts) > 1 else ""
    city = re.sub(r"\s+", " ", _PORT_NOISE.sub(" ", city)).strip() or city
    aliases = dict(PORT_ALIASES)
    if extra_aliases:
        aliases.update({k.upper(): v.upper() for k, v in extra_aliases.items()})
    full = re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9/ ]+", " ", s)).strip()
    key = aliases.get(full) or aliases.get(city) or aliases.get("PORT " + city) or city
    country = COUNTRY_ALIASES.get(country, country)
    return {"city": city, "country": country, "locode": locode, "key": key}


# ------------------------------------------------------------------ parties
_ORDER_PREFIX = re.compile(r"^\s*(TO\s+(THE\s+)?ORDER(\s+OF)?|UNTO\s+ORDER(\s+OF)?|ORDER\s+OF|M/S\.?|MESSRS\.?)\s*[:\-]?\s*")
_LEGAL_EQUIV = [
    (r"\bSENDIRIAN\s+BERHAD\b", "SDN BHD"), (r"\bBERHAD\b", "BHD"), (r"\bLIMITED\b", "LTD"),
    (r"\bPRIVATE\b", "PTE"), (r"\bPVT\b", "PTE"), (r"\bCOMPANY\b", "CO"), (r"\bCORPORATION\b", "CORP"),
    (r"\bINCORPORATED\b", "INC"), (r"\bL\s*L\s*C\b", "LLC"), (r"\bF\s*Z\s*E\b", "FZE"),
    (r"\bF\s*Z\s*C\s*O?\b", "FZCO"), (r"\bG\s*M\s*B\s*H\b", "GMBH"), (r"\bJOINT STOCK COMPANY\b", "JSC"),
    (r"\bPUBLIC LIMITED COMPANY\b", "PLC"), (r"\bAND\b", "&"),
]
LEGAL_TOKENS = {"SDN", "BHD", "LTD", "PTE", "CO", "CORP", "INC", "LLC", "FZE", "FZCO", "GMBH", "JSC",
                "PLC", "PTY", "PT", "TBK", "SA", "AG", "BV", "NV", "SRL", "SPA", "LLP", "LP", "FZ", "UAB",
                "AS", "OY", "AB", "KK", "M"}
ORDER_ONLY = re.compile(r"^\s*(TO\s+(THE\s+)?ORDER|TO\s+ORDER\s+OF\s+(THE\s+)?(SHIPPER|BANK|HOLDER)|UNTO\s+ORDER)\s*$")


def normalise_party(value: str) -> str:
    s = _ascii_upper(value or "")
    s = _ORDER_PREFIX.sub("", s).replace(".", "")
    for rx, rep in _LEGAL_EQUIV:
        s = re.sub(rx, rep, s)
    s = s.replace("&", " & ")
    s = re.sub(r"[^A-Z0-9& ]+", " ", s)       # punctuation never distinguishes companies
    return re.sub(r"\s+", " ", s).strip()


def party_core(norm: str) -> str:
    """Name without legal-form tokens (for 'same company, suffix dropped' detection)."""
    toks = [t for t in norm.split() if t not in LEGAL_TOKENS and t != "&"]
    return " ".join(toks)


def is_order_only(value: str) -> bool:
    return bool(ORDER_ONLY.match(_ascii_upper(value or "")))
