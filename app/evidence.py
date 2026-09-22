"""Evidence images for PDFs and scans: a cropped PNG around the value's
bounding box with a highlight rectangle. Cached on disk by content hash.
(txt / xlsx / docx evidence is rendered by the UI from the stored context rows.)"""
import hashlib

from app import config


def _open(data: bytes, fmt: str):
    import pymupdf
    if fmt == "image":
        img = pymupdf.open(stream=data, filetype="png" if data[:4] == b"\x89PNG" else "jpg")
        return pymupdf.open("pdf", img.convert_to_pdf())
    return pymupdf.open(stream=data, filetype="pdf")


def crop_png(data: bytes, loc: dict, fmt: str = "pdf", pad_x: float = 90, pad_y: float = 38, dpi: int = 170) -> bytes:
    import pymupdf
    key = hashlib.sha1(data[:4096] + repr(sorted(loc.items())).encode() + f"{pad_x}{pad_y}{dpi}".encode()).hexdigest()
    config.EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    cache = config.EVIDENCE_DIR / f"{key}.png"
    if cache.exists():
        return cache.read_bytes()
    doc = _open(data, fmt)
    page = doc[int(loc.get("page", 0))]
    x0, y0, x1, y1 = loc["bbox"]
    box = pymupdf.Rect(x0, y0, x1, y1)
    # highlight: translucent fill + outline, drawn on a copy of the page
    shape = page.new_shape()
    shape.draw_rect(pymupdf.Rect(x0 - 2, y0 - 2, x1 + 2, y1 + 2))
    shape.finish(color=(0.85, 0.19, 0.15), fill=(1, 0.84, 0.2), fill_opacity=0.35, width=1.2)
    shape.commit(overlay=True)
    clip = pymupdf.Rect(max(0, page.rect.x0), box.y0 - pad_y, page.rect.x1, box.y1 + pad_y) & page.rect
    clip.x0 = max(page.rect.x0, min(box.x0 - pad_x, 40))
    clip.x1 = min(page.rect.x1, max(box.x1 + pad_x, box.x0 + 330))
    png = page.get_pixmap(dpi=dpi, clip=clip).tobytes("png")
    cache.write_bytes(png)
    return png


def page_png(data: bytes, page_no: int = 0, fmt: str = "pdf", dpi: int = 110) -> bytes:
    doc = _open(data, fmt)
    return doc[min(page_no, len(doc) - 1)].get_pixmap(dpi=dpi).tobytes("png")
