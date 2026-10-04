"""Shared Gemini client (one per process). None when no API key is configured."""

import logging

log = logging.getLogger(__name__)
_client = None
_resolved = False


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
