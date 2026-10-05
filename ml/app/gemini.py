"""Shared Gemini client (one per process) plus a rate-limit circuit breaker.

On a 429 we stop calling Gemini for the retry delay Google returns (default 30 s), so callers
fall back to local implementations instantly instead of paying for a doomed round trip each time.
"""

import logging
import re
import threading
import time

log = logging.getLogger(__name__)
_client = None
_resolved = False
_lock = threading.Lock()
_paused_until = 0.0


def client(api_key: str):
    global _client, _resolved
    if not _resolved:
        _resolved = True
        if api_key:
            from google import genai

            _client = genai.Client(api_key=api_key)
        else:
            log.info("GOOGLE_API_KEY not set: Gemini features use their local fallbacks")
    return _client


def available() -> bool:
    return time.monotonic() >= _paused_until


def note_failure(exc: Exception) -> None:
    """Call with any Gemini exception; rate limits pause all Gemini use for the advised delay."""
    global _paused_until
    text = str(exc)
    if "429" not in text and "RESOURCE_EXHAUSTED" not in text:
        return
    m = re.search(r"retry(?:Delay)?['\"]?:?\s*['\"]?(\d+(?:\.\d+)?)s", text, re.I) or re.search(
        r"retry in (\d+(?:\.\d+)?)s", text, re.I
    )
    if "PerDay" in text:
        # Daily quota (the free tier allows ~20 requests/day per model): no point retrying for a while.
        delay = 3600.0
    else:
        delay = min(float(m.group(1)) if m else 30.0, 300.0)
    with _lock:
        _paused_until = max(_paused_until, time.monotonic() + delay)
    log.warning("Gemini rate limited; using local fallbacks for %.0fs", delay)
