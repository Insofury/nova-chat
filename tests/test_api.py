from __future__ import annotations

import base64

from tests.conftest import parse_sse

USER_HI = {"messages": [{"role": "user", "content": "Hi"}]}


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_config_lists_models_personas_and_efforts(client):
    data = client.get("/api/config").json()
    model_ids = [m["id"] for m in data["models"]]
    assert "claude-opus-5-5" in model_ids
    assert data["default_model"] == "claude-opus-5-5"
    assert {e["id"] for e in data["efforts"]} == {"low", "medium", "high"}
    assert any(p["id"] == "coder" for p in data["personas"])
    assert data["access_code_required"] is False


def test_index_and_static_files_are_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "NovaChat" in res.text
    assert client.get("/static/js/app.js").status_code == 200
    assert client.get("/favicon.ico").status_code == 200
    assert client.head("/").status_code == 200  # uptime monitors often use HEAD


def test_security_headers_present(client):
    res = client.get("/")
    assert "default-src 'self'" in res.headers["content-security-policy"]
    assert res.headers["x-content-type-options"] == "nosniff"


def test_chat_streams_engine_events(client, engine):
    res = client.post("/api/chat", json=USER_HI)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(res.text)
    assert [e for e, _ in events] == ["start", "thinking", "delta", "delta", "done"]
    assert "".join(d["text"] for e, d in events if e == "delta") == "Hello world"
    job = engine.jobs[0]
    assert job.model == "claude-opus-5-5"
    assert job.effort == "medium"
    assert job.messages == [{"role": "user", "content": "Hi"}]


def test_chat_passes_options_through(client, engine):
    body = {
        "messages": [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
            {"role": "user", "content": "Write code"},
        ],
        "model": "claude-haiku-5-5",
        "effort": "low",
        "persona": "coder",
        "custom_instructions": "Use Python 3.12",
        "show_thinking": False,
    }
    assert client.post("/api/chat", json=body).status_code == 200
    job = engine.jobs[0]
    assert job.model == "claude-haiku-5-5"
    assert job.effort == "low"
    assert job.show_thinking is False
    assert "senior software engineer" in job.system
    assert "Use Python 3.12" in job.system
    assert len(job.messages) == 3


def test_chat_rejects_unknown_model(client):
    res = client.post("/api/chat", json={**USER_HI, "model": "gpt-nope"})
    assert res.status_code == 400
    assert "Unknown model" in res.json()["detail"]


def test_chat_rejects_unknown_effort(client):
    assert client.post("/api/chat", json={**USER_HI, "effort": "ultra"}).status_code == 400


def test_chat_requires_last_message_from_user(client):
    body = {"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]}
    assert client.post("/api/chat", json=body).status_code == 400


def test_chat_rejects_empty_message_list(client):
    assert client.post("/api/chat", json={"messages": []}).status_code == 422


def test_chat_skips_empty_assistant_turns(client, engine):
    body = {
        "messages": [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": "Again"},
        ]
    }
    assert client.post("/api/chat", json=body).status_code == 200
    assert [m["role"] for m in engine.jobs[0].messages] == ["user", "user"]


def test_chat_with_image_builds_content_blocks(client, engine):
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 32).decode()
    body = {"messages": [{"role": "user", "content": "What's this?", "images": [{"media_type": "image/png", "data": png}]}]}
    assert client.post("/api/chat", json=body).status_code == 200
    content = engine.jobs[0].messages[0]["content"]
    assert content[0]["type"] == "image"
    assert content[0]["source"]["media_type"] == "image/png"
    assert content[1] == {"type": "text", "text": "What's this?"}


def test_chat_rejects_too_many_images(make_client):
    client = make_client(max_images_per_message=1)
    img = {"media_type": "image/png", "data": base64.b64encode(b"x" * 10).decode()}
    body = {"messages": [{"role": "user", "content": "hi", "images": [img, img]}]}
    assert client.post("/api/chat", json=body).status_code == 400


def test_chat_rejects_invalid_base64(client):
    body = {"messages": [{"role": "user", "content": "hi", "images": [{"media_type": "image/png", "data": "@@@"}]}]}
    assert client.post("/api/chat", json=body).status_code == 400


def test_chat_rejects_bad_media_type(client):
    body = {"messages": [{"role": "user", "content": "hi", "images": [{"media_type": "image/bmp", "data": "eA=="}]}]}
    assert client.post("/api/chat", json=body).status_code == 422


def test_access_code(make_client):
    client = make_client(access_code="s3cret")
    assert client.get("/api/config").json()["access_code_required"] is True
    assert client.post("/api/chat", json=USER_HI).status_code == 401
    assert client.post("/api/chat", json=USER_HI, headers={"X-Access-Code": "wrong"}).status_code == 401
    assert client.post("/api/chat", json=USER_HI, headers={"X-Access-Code": "s3cret"}).status_code == 200


def test_rate_limit(make_client):
    client = make_client(rate_limit_per_minute=2)
    assert client.post("/api/chat", json=USER_HI).status_code == 200
    assert client.post("/api/chat", json=USER_HI).status_code == 200
    res = client.post("/api/chat", json=USER_HI)
    assert res.status_code == 429
    assert int(res.headers["retry-after"]) >= 1


def test_body_size_limit(make_client):
    client = make_client(max_request_bytes=100)
    res = client.post("/api/chat", json={"messages": [{"role": "user", "content": "x" * 500}]})
    assert res.status_code == 413


def test_demo_engine_end_to_end(demo_client):
    res = demo_client.post("/api/chat", json={"messages": [{"role": "user", "content": "Hello there"}]})
    events = parse_sse(res.text)
    names = [e for e, _ in events]
    assert names[0] == "start" and names[-1] == "done"
    text = "".join(d["text"] for e, d in events if e == "delta")
    assert "demo mode" in text
    assert "> Hello there" in text
    assert demo_client.get("/api/health").json()["mode"] == "demo"
