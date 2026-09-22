"""Avery's email preview: one or two plain sentences saying who is asking for what, written by the AI ONCE when
the email is processed and saved with the result (answers are cached by content, so re-runs cost nothing).
Without a key, or over budget, there is simply no preview and Avery falls back to his hand-written line."""
from app import llm
from app.ingest.clean import clean_body

SYSTEM = ("You help a new clerk in a shipping documents office who does not know shipping words. Read the email "
          "and say, in one or two short plain sentences (at most 30 words), who is writing and what they want. "
          "No jargon: say 'the shipping line's draft' not 'BL', 'the customer's instructions' not 'SI'. "
          "Name the writer by the name in the email or the From address; if there is none say 'The sender'. "
          "The writer is a customer or a colleague: never call the writer 'the shipping line'. "
          "If it looks like a scam or an advert, say so plainly. "
          "Do not judge whether documents match. Do not invent details.")


def add_preview(res: dict, email: dict, settings: dict | None = None) -> dict:
    if (settings or {}).get("llm_enabled", True) is False or not llm.available():
        return res
    message = clean_body(email.get("body") or "").message[:1500]
    if not message.strip():
        return res
    out = llm.complete_json(SYSTEM, f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n\n{message}",
                            '{"preview": "string"}', max_tokens=120)
    text = (out or {}).get("preview")
    if isinstance(text, str) and 10 < len(text) < 400:
        res["preview"] = text.strip()
    return res
