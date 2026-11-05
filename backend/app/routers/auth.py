"""认证：单账号登录/登出/会话查询。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..deps import require_session
from ..schemas import LoginIn

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(payload: LoginIn, request: Request, response: Response):
    settings = request.app.state.settings
    from ..security import verify_password

    if payload.username != settings.username or not verify_password(
        payload.password, settings.password
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名或密码错误")
    request.app.state.sessions.set_cookie(response, payload.username)
    return {"username": payload.username}


@router.post("/logout")
def logout(request: Request, response: Response, _user: str = Depends(require_session)):
    request.app.state.sessions.clear_cookie(response)
    return {"ok": True}


@router.get("/me")
def me(_user: str = Depends(require_session)):
    return {"username": _user}
