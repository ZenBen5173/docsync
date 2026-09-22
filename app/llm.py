"""LLM access: provider from env (LLM_PROVIDER / LLM_MODEL / key), temperature 0,
JSON-only answers, responses cached on disk by content hash. When no key is
configured `available()` is False and every caller falls back to its
deterministic path - the product must keep working without an LLM."""
import hashlib
import json
import re

import httpx

from app import config

DEFAULT_MODELS = {"anthropic": "claude-sonnet-5", "openai": "gpt-4o-mini"}


def provider() -> str:
    if config.LLM_PROVIDER:
        return config.LLM_PROVIDER
    import os
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return ""


def available() -> bool:
    return bool(provider() and config.LLM_API_KEY)


def model() -> str:
    return config.LLM_MODEL or DEFAULT_MODELS.get(provider(), "")


def _usage_file():
    return config.VAR_DIR / "llm_usage.json"


def usage() -> dict:
    """What the AI has cost so far (as reported by the provider), so a run can never overspend."""
    try:
        return json.loads(_usage_file().read_text(encoding="utf-8"))
    except Exception:
        return {"calls": 0, "cost_usd": 0.0, "tokens": 0}


TASKS = {"preview": "Email previews", "llm_classify": "Sorting unclear emails", "llm_extract": "Reading hard documents",
         "learning": "Learning from corrections", "analytics": "Report summary"}


def _task() -> str:
    """Which job is paying for this call, worked out from the module that asked (no call site has to say)."""
    import inspect
    for frame in inspect.stack()[2:8]:
        name = frame.filename.replace("\\", "/").rsplit("/", 1)[-1].removesuffix(".py")
        if name in TASKS:
            return TASKS[name]
    return "Other"


def _record(resp: dict):
    u, got = usage(), resp.get("usage") or {}
    cost = float(got.get("cost") or 0)
    if "by_task" not in u:                          # spend from before per-task tracking existed stays visible, unattributed
        u["by_task"] = {"Email previews and setup (before tracking by task)": {"calls": u["calls"], "cost_usd": u["cost_usd"]}} if u["calls"] else {}
    t = u["by_task"].setdefault(_task(), {"calls": 0, "cost_usd": 0.0})
    t["calls"] += 1
    t["cost_usd"] = round(t["cost_usd"] + cost, 6)
    u["calls"] += 1
    u["tokens"] += int(got.get("total_tokens") or 0)
    u["cost_usd"] = round(u["cost_usd"] + cost, 6)
    try:
        _usage_file().write_text(json.dumps(u), encoding="utf-8")
    except Exception:
        pass


def over_budget() -> bool:
    return bool(config.LLM_BUDGET_USD) and usage()["cost_usd"] >= config.LLM_BUDGET_USD


def _cache_path(key: str):
    config.LLM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return config.LLM_CACHE_DIR / f"{key}.json"


def complete_json(system: str, user: str, schema_hint: str = "", max_tokens: int = 1500) -> dict | None:
    """Return the parsed JSON object, or None when no LLM is available / it failed."""
    if not available():
        return None
    prov, mdl = provider(), model()
    key = hashlib.sha256(json.dumps([prov, mdl, system, user, schema_hint]).encode()).hexdigest()[:32]
    cp = _cache_path(key)
    if cp.exists():
        return json.loads(cp.read_text(encoding="utf-8"))
    if over_budget():
        return None                                 # the cap is reached: fall back to the rules, never overspend
    sys_prompt = system + "\n\nAnswer with ONE JSON object only, no prose, no code fences." + (
        f"\nJSON schema:\n{schema_hint}" if schema_hint else "")
    try:
        if prov == "anthropic":
            base = __import__("os").environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
            r = httpx.post(f"{base}/v1/messages", timeout=90, headers={
                "x-api-key": config.LLM_API_KEY, "anthropic-version": "2023-06-01",
                "content-type": "application/json"}, json={
                "model": mdl, "max_tokens": max_tokens, "temperature": 0, "system": sys_prompt,
                "messages": [{"role": "user", "content": user}]})
            r.raise_for_status()
            text = "".join(b.get("text", "") for b in r.json()["content"])
        else:  # openai-compatible
            base = __import__("os").environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
            r = httpx.post(f"{base}/chat/completions", timeout=90, headers={
                "Authorization": f"Bearer {config.LLM_API_KEY}"}, json={
                "model": mdl, "temperature": 0, "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
                **({"usage": {"include": True}} if "openrouter" in base else {}),     # OpenRouter then reports the real cost
                "messages": [{"role": "system", "content": sys_prompt}, {"role": "user", "content": user}]})
            r.raise_for_status()
            _record(r.json())
            text = r.json()["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", text, re.S)
        data = json.loads(m.group(0)) if m else None
    except Exception:
        return None
    if data is not None:
        cp.write_text(json.dumps(data), encoding="utf-8")
    return data
