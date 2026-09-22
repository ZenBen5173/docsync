"""Tiny in-process pub/sub used for live UI updates (SSE). Publishers may be
worker threads; subscribers are asyncio queues owned by the API event loop."""
import asyncio
import json
import threading

_subs: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
_lock = threading.Lock()


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=1000)
    with _lock:
        _subs.append((asyncio.get_running_loop(), q))
    return q


def unsubscribe(q: asyncio.Queue):
    with _lock:
        _subs[:] = [(l, x) for l, x in _subs if x is not q]


def publish(event: str, data: dict):
    msg = json.dumps({"event": event, **data}, default=str)
    with _lock:
        subs = list(_subs)
    for loop, q in subs:
        try:
            loop.call_soon_threadsafe(_put, q, msg)
        except RuntimeError:
            pass


def _put(q: asyncio.Queue, msg: str):
    if not q.full():
        q.put_nowait(msg)
