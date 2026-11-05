"""分类树管理 API 测试。"""
from fastapi.testclient import TestClient

from conftest import seed_categories


def test_create_and_list_tree(client_authed: TestClient):
    ids = seed_categories(client_authed)
    tree = client_authed.get("/api/categories").json()
    names = {n["name"] for n in tree}
    assert {"技术", "文学"} <= names
    tech = next(n for n in tree if n["name"] == "技术")
    assert tech["level"] == 1
    assert [c["name"] for c in tech["children"]] == ["编程"]
    prog = tech["children"][0]
    assert prog["level"] == 2 and prog["parent_id"] == ids["l1a"]
    assert [c["name"] for c in prog["children"]] == ["Python"]


def test_reject_fourth_level(client_authed: TestClient):
    ids = seed_categories(client_authed)
    resp = client_authed.post("/api/categories", json={"name": "更深", "parent_id": ids["l3a"]})
    assert resp.status_code == 422


def test_reject_unknown_parent(client_authed: TestClient):
    assert client_authed.post("/api/categories", json={"name": "x", "parent_id": 999}).status_code == 422


def test_rename_and_reorder(client_authed: TestClient):
    ids = seed_categories(client_authed)
    resp = client_authed.patch(f"/api/categories/{ids['l3a']}", json={"name": "Python 3", "sort_order": 5})
    assert resp.status_code == 200
    node = resp.json()
    assert node["name"] == "Python 3" and node["sort_order"] == 5


def test_move_validations(client_authed: TestClient):
    ids = seed_categories(client_authed)
    # 带子分类不能移动
    assert client_authed.patch(
        f"/api/categories/{ids['l2a']}", json={"parent_id": ids["l2b"]}
    ).status_code == 422
    # 层级不匹配：二级不能移到三级之下
    leaf2 = client_authed.post("/api/categories", json={"name": "算法", "parent_id": ids["l1a"]}).json()
    assert client_authed.patch(
        f"/api/categories/{leaf2['id']}", json={"parent_id": ids["l3a"]}
    ).status_code == 422
    # 移到另一个一级之下成功
    assert client_authed.patch(
        f"/api/categories/{leaf2['id']}", json={"parent_id": ids["l1b"]}
    ).status_code == 200
    tree = client_authed.get("/api/categories").json()
    lit = next(n for n in tree if n["name"] == "文学")
    assert {c["name"] for c in lit["children"]} == {"小说", "算法"}


def test_delete_rules(client_authed: TestClient):
    ids = seed_categories(client_authed)
    # 有子分类拒绝删除
    assert client_authed.delete(f"/api/categories/{ids['l2a']}").status_code == 422
    # 叶子可删
    assert client_authed.delete(f"/api/categories/{ids['l3a']}").status_code == 200
    tree = client_authed.get("/api/categories").json()
    tech = next(n for n in tree if n["name"] == "技术")
    assert tech["children"][0]["children"] == []
