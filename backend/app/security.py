"""单账号认证：PBKDF2 口令校验 + itsdangerous 签名会话 Cookie。"""
from __future__ import annotations

import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import Settings

SESSION_COOKIE = "zzlib_session"
_PBKDF2_ITERATIONS = 240_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2${_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if stored.startswith("pbkdf2$"):
        try:
            _, iters, salt_hex, hash_hex = stored.split("$")
            digest = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iters)
            )
            return hmac.compare_digest(digest.hex(), hash_hex)
        except ValueError:
            return False
    # 明文配置（个人局域网部署的便捷选项）
    return hmac.compare_digest(password, stored)


class SessionManager:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._serializer = URLSafeTimedSerializer(
            settings.effective_session_secret(), salt="zzlib-session"
        )

    def issue(self, username: str) -> str:
        return self._serializer.dumps({"u": username})

    def resolve(self, token: str | None) -> str | None:
        if not token:
            return None
        try:
            data = self._serializer.loads(token, max_age=self._settings.session_max_age)
        except (BadSignature, SignatureExpired):
            return None
        return data.get("u")

    def set_cookie(self, response, username: str) -> None:
        response.set_cookie(
            SESSION_COOKIE,
            self.issue(username),
            max_age=self._settings.session_max_age,
            httponly=True,
            samesite="lax",
            path="/",
        )

    def clear_cookie(self, response) -> None:
        response.delete_cookie(SESSION_COOKIE, path="/")


def make_auth_dependency(settings: Settings, sessions: SessionManager):
    def require_session(request: Request) -> str:
        username = sessions.resolve(request.cookies.get(SESSION_COOKIE))
        if username is None or username != settings.username:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="未登录或会话已过期",
            )
        return username

    return require_session
