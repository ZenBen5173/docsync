"""Format-neutral document model. Every reader (txt/pdf/xlsx/docx/ocr) turns
a file into `Row`s that carry their source location, so extraction and the
evidence viewer work the same way for every format."""
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Row:
    text: str                       # full visible text of the row
    loc: dict                       # where it came from (see readers.py)
    label: str | None = None        # set when the format separates label/value (cells, columns)
    value: str | None = None
    value_loc: dict | None = None   # location of the value part, when known
    indent: bool = False            # visually a continuation of the row above
    words: list | None = None       # [(text, [x0,y0,x1,y1])] for PDF rows, to locate a value inside the line


@dataclass
class Document:
    path: str
    fmt: str                        # txt | pdf | xlsx | docx | unknown
    rows: list[Row] = field(default_factory=list)
    method: str = "text"            # text | ocr
    readable: bool = True
    error: str | None = None
    ocr_confidence: float | None = None
    meta: dict = field(default_factory=dict)

    @property
    def text(self) -> str:
        return "\n".join(r.text for r in self.rows)


@dataclass
class FieldValue:
    field: str
    raw: str | None                 # value exactly as written (first line for parties)
    full: str | None = None         # full block (name + address)
    label: str | None = None        # the label as written in the document
    loc: dict | None = None
    row_index: int | None = None
    confidence: float = 0.0
    method: str = "rule"            # rule | prefix | fuzzy | llm | ocr | human
    blank: bool = False             # present but empty / placeholder
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
