"""应用配置：环境变量（前缀 ZZLIB_）或仓库根 .env 文件。"""
from __future__ import annotations

import secrets
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ZZLIB_",
        env_file=(REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 数据目录：库文件、原件、封面/书脊缓存、上传暂存
    data_dir: Path = REPO_ROOT / "data"

    # 单账号
    username: str = "admin"
    # 明文或 pbkdf2$iterations$salt_hex$hash_hex 格式
    password: str = "zzlibrary"

    # 会话签名密钥；未配置时自动生成并持久化到 data/.session_secret
    session_secret: str | None = None
    session_max_age: int = 30 * 24 * 3600  # 30 天

    # 允许携带凭证的跨域来源（Expo 开发等），逗号分隔
    cors_origins: str = ""

    @property
    def db_path(self) -> Path:
        return self.data_dir / "library.db"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def art_dir(self) -> Path:
        return self.data_dir / "art"

    @property
    def staging_dir(self) -> Path:
        return self.data_dir / "staging"

    def ensure_dirs(self) -> None:
        for sub in ("files", "art/covers", "art/spines", "staging"):
            (self.data_dir / sub).mkdir(parents=True, exist_ok=True)

    def effective_session_secret(self) -> str:
        if self.session_secret:
            return self.session_secret
        secret_file = self.data_dir / ".session_secret"
        if secret_file.exists():
            saved = secret_file.read_text(encoding="utf-8").strip()
            if saved:
                return saved
        self.data_dir.mkdir(parents=True, exist_ok=True)
        generated = secrets.token_urlsafe(48)
        secret_file.write_text(generated, encoding="utf-8")
        return generated


# 默认全局实例（uvicorn 使用）；测试用 create_app(Settings(...)) 构造独立实例
_default = Settings()


def default_settings() -> Settings:
    return _default
