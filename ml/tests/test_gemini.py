import app.gemini as g


def test_rate_limit_pauses_gemini_for_advised_delay(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(g.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(g, "_paused_until", 0.0)
    assert g.available()
    g.note_failure(Exception("429 RESOURCE_EXHAUSTED ... 'retryDelay': '37s'"))
    assert not g.available()
    now[0] += 38
    assert g.available()


def test_other_errors_do_not_pause(monkeypatch):
    monkeypatch.setattr(g, "_paused_until", 0.0)
    g.note_failure(Exception("400 INVALID_ARGUMENT"))
    assert g.available()


def test_daily_quota_pauses_for_an_hour(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(g.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(g, "_paused_until", 0.0)
    g.note_failure(Exception("429 RESOURCE_EXHAUSTED quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier"))
    now[0] = 3500
    assert not g.available()
    now[0] = 3601
    assert g.available()
