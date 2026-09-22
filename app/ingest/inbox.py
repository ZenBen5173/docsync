"""Inbox access: local bundle folder or the organisers' HTTP server.
Same surface as the participant `loader.py`, kept dependency-free."""
import json
import urllib.request
from pathlib import Path


class Inbox:
    def __init__(self, source: str):
        self.source = str(source).rstrip("/\\")
        self.is_http = self.source.startswith(("http://", "https://"))

    def emails(self) -> list[dict]:
        if self.is_http:
            return self._get_json("/emails")
        inbox_dir = Path(self.source) / "inbox"
        return [json.loads(p.read_text(encoding="utf-8"))
                for p in sorted(inbox_dir.glob("email_*.json"))]

    def __iter__(self):
        return iter(self.emails())

    def read_bytes(self, att_path: str) -> bytes:
        if self.is_http:
            with urllib.request.urlopen(self.source + "/" + att_path.lstrip("/")) as r:
                return r.read()
        return (Path(self.source) / att_path).read_bytes()

    def submit(self, submission: dict, base_url: str | None = None) -> dict:
        url = (base_url or self.source).rstrip("/") + "/submit"
        req = urllib.request.Request(url, data=json.dumps(submission).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())

    def _get_json(self, path):
        with urllib.request.urlopen(self.source + path) as r:
            return json.loads(r.read())
