"""Knowledge base used by the pipeline. It is a plain in-memory view over
`kb_items` rows so the pipeline stays testable without a database.

Item kinds
  port_alias       key "PORT KELANG"          value "PORT KLANG"
  party_alias      key "EAST BRIGHT FZ LLC"   value "EAST BRIGHT FZ-LLC"   (same legal entity)
  label_alias      key "cnee name"            value "consignee"
  classifier_hint  key regex                  value category               (meta.weight)
  carrier_prefix   key "MEDU"                 value "MSC"                  (B/L number prefix -> shipping line)
  reply_rule       key status (MISMATCH...)   value text appended to the auto-draft
  example          key free text              value past correction, shown to the LLM as a few-shot
"""
from app.compare.normalize import normalise_party
from app.extract.fields import normalise_label

SEED_ITEMS = [
    {"kind": "port_alias", "key": "PORT KELANG", "value": "PORT KLANG", "note": "Old spelling", "source": "seed"},
    {"kind": "port_alias", "key": "HOCHIMINH CITY", "value": "HO CHI MINH", "note": "Spacing variant", "source": "seed"},
    {"kind": "port_alias", "key": "SAIGON", "value": "HO CHI MINH", "note": "Former name", "source": "seed"},
    {"kind": "port_alias", "key": "JNPT", "value": "NHAVA SHEVA", "note": "Terminal name for the same port", "source": "seed"},
    {"kind": "port_alias", "key": "PUSAN", "value": "BUSAN", "note": "Old romanisation", "source": "seed"},
    {"kind": "carrier_prefix", "key": "SINF", "value": "ONE", "note": "B/L numbering seen in this inbox", "source": "seed"},
    {"kind": "carrier_prefix", "key": "SIJ", "value": "CMA CGM", "note": "B/L numbering seen in this inbox", "source": "seed"},
    {"kind": "carrier_prefix", "key": "MCLSIN", "value": "Monter", "note": "B/L numbering seen in this inbox", "source": "seed"},
    {"kind": "carrier_prefix", "key": "SIN", "value": "PIL", "note": "Singapore-issued PIL B/Ls; longer prefixes win", "source": "seed"},
    {"kind": "label_alias", "key": "cnee", "value": "consignee", "note": "Common abbreviation", "source": "seed"},
    {"kind": "label_alias", "key": "g w kgs", "value": "gross_weight_kg", "note": "Abbreviated label", "source": "seed"},
]


class KnowledgeBase:
    def __init__(self, items: list[dict] | None = None):
        self.items = [i for i in (items or []) if i.get("active", True)]
        self._ports = {i["key"].upper().strip(): i["value"].upper().strip()
                       for i in self.items if i["kind"] == "port_alias"}
        self._parties = {normalise_party(i["key"]): normalise_party(i["value"])
                         for i in self.items if i["kind"] == "party_alias"}
        self._labels = {normalise_label(i["key"]): i["value"]
                        for i in self.items if i["kind"] == "label_alias"}

    def port_aliases(self) -> dict[str, str]:
        return self._ports

    def canonical_party(self, norm: str) -> str:
        return self._parties.get(norm, norm)

    def label_alias(self, norm_label: str) -> str | None:
        return self._labels.get(norm_label)

    def classifier_hints(self) -> list[dict]:
        return [{"pattern": i["key"], "category": i["value"], "weight": (i.get("meta") or {}).get("weight", 2.0)}
                for i in self.items if i["kind"] == "classifier_hint"]

    def carrier_prefixes(self) -> dict[str, str]:
        return {i["key"]: i["value"] for i in self.items if i["kind"] == "carrier_prefix"}

    def reply_rules(self, status: str) -> list[str]:
        return [i["value"] for i in self.items if i["kind"] == "reply_rule" and i["key"].upper() in (status, "ALL")]

    def examples(self, limit: int = 5) -> list[dict]:
        return [i for i in self.items if i["kind"] == "example"][-limit:]

    def version(self) -> str:
        import hashlib, json
        return hashlib.sha1(json.dumps(sorted((i["kind"], i["key"], i["value"]) for i in self.items))
                            .encode()).hexdigest()[:10]
