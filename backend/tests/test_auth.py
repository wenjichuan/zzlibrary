"""认证 API 测试。"""
from fastapi.testclient import TestClient

from conftest import PASSWORD, USERNAME


def test_health_open(client):
    assert client.get("/api/health").status_code == 200


def test_login_required_endpoints_reject_anonymous(client):
    for path in ("/api/auth/me", "/api/categories", "/api/packages", "/api/shelves?l1=1"):
        assert client.get(path).status_code == 401, path


def test_login_bad_credentials(client):
    resp = client.post("/api/auth/login", json={"username": USERNAME, "password": "wrong"})
    assert resp.status_code == 401


def test_login_logout_flow(client):
    resp = client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD})
    assert resp.status_code == 200
    assert resp.json() == {"username": USERNAME}

    assert client.get("/api/auth/me").status_code == 200

    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401
