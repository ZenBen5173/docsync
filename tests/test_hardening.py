"""Things that only matter once the app is on the public internet."""
import pytest

from app.safe_regex import check_user_regex, user_search


@pytest.mark.parametrize("pattern", ["(.+)+Z", "(a+)+$", "(a|aa)+$", "(a|a)*b", r"(\w+\s?)*$", "((ab)*)+", r"(x)\1+", "a" * 500])
def test_catastrophic_patterns_are_rejected(pattern):
    assert check_user_regex(pattern) is not None
    assert user_search(pattern, "a" * 40 + "!") is False        # and never executed


@pytest.mark.parametrize("pattern,text,hit", [
    (r"^(?!.*april).*$", "vitalsolutions.sg", True), (r"^(?!.*april).*$", "aprilasia.com", False),
    (r"maersk|msc", "Draft BL from MSC", True), (r"^draft\s+bl", "Draft BL 123", True),
    (r"Please\s+find\s+attached", "please find  attached the SI", True), (r"\binvoice\b", "no such word", False),
])
def test_ordinary_patterns_still_work(pattern, text, hit):
    assert check_user_regex(pattern) is None
    assert user_search(pattern, text) is hit


def test_invalid_pattern_never_raises():
    assert check_user_regex("([a-z") is not None
    assert user_search("([a-z", "abc") is False


def test_slow_pattern_that_passes_the_shape_check_is_cut_off_by_the_timeout(monkeypatch):
    import time
    from app import safe_regex
    monkeypatch.setattr(safe_regex, "TIMEOUT_S", 0.05)            # keep the test fast; production uses 2 s
    # passes the shape filter (no nested group) but backtracks exponentially on this input
    pattern, text = r"a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a" * 4000
    assert safe_regex.check_user_regex(pattern) is None
    for _ in range(safe_regex.STRIKES):
        assert safe_regex.user_search(pattern, text) is False     # each attempt is cut off ...
    t0 = time.perf_counter()
    for _ in range(500):                                          # ... and after 3 strikes it is never run again
        assert safe_regex.user_search(pattern, text) is False
    assert time.perf_counter() - t0 < 0.2


def test_a_cheap_rule_never_times_out_while_other_threads_are_busy():
    """Regression: with a 50 ms wall-clock timeout the seed rule lost 124 of its 127 matches during a
    pipeline run, because waiting for the GIL counted against the pattern and one timeout disabled it."""
    import threading
    from app import safe_regex
    stop = threading.Event()

    def burn():
        while not stop.is_set():
            sum(i * i for i in range(2000))
    threads = [threading.Thread(target=burn, daemon=True) for _ in range(8)]
    [t.start() for t in threads]
    try:
        hits = sum(safe_regex.user_search(r"^(?!.*april).*$", "vitalsolutions.sg") for _ in range(120))
    finally:
        stop.set()
        [t.join() for t in threads]
    assert hits == 120
    assert safe_regex._strikes.get(r"^(?!.*april).*$", 0) == 0


def test_bounded_repeat_of_a_group_is_refused_at_save_time():
    assert check_user_regex("(x*y){12}") is not None
