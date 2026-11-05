"""数据模型（SQLite）。

- categories：三级分类树，层级校验在服务层
- packages：资料包（书架最小单位），元数据 + 发布时间 + 聚合状态
- package_paths：包的多条分类路径（l1 必填，l2/l3 可空；链校验 + 去重）
- files：包内文件（EPUB/PDF/Office/文本/视频/音频/图片），原件路径相对 data 目录
- reading_progress：按文件记录（EPUB=CFI、PDF=页码、文本=百分比、媒体=播放秒数），
  包状态由包内文件进度聚合
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    level: Mapped[int] = mapped_column(Integer)  # 1 / 2 / 3
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="RESTRICT"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    children: Mapped[list["Category"]] = relationship(
        back_populates="parent",
        order_by="Category.sort_order, Category.id",
    )
    parent: Mapped["Category | None"] = relationship(back_populates="children", remote_side="Category.id")


class Package(Base):
    __tablename__ = "packages"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(500))  # 包名
    authors: Mapped[list] = mapped_column(JSON, default=list)  # list[str]
    # 带符号定宽年文本（前221 → -0221-01-01；定宽保证字典序=时间序），公元前可存
    publish_date: Mapped[str | None] = mapped_column(String(11), nullable=True)
    publisher: Mapped[str | None] = mapped_column(String(300), nullable=True)
    tags: Mapped[list] = mapped_column(JSON, default=list)  # list[str]
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="未读")  # 未读/在读/已读
    file_count: Mapped[int] = mapped_column(Integer, default=0)  # 冗余计数
    total_size: Mapped[int] = mapped_column(Integer, default=0)  # 冗余字节数
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    files: Mapped[list["FileItem"]] = relationship(
        back_populates="package",
        order_by="FileItem.sort_order, FileItem.id",
        cascade="all, delete-orphan",
    )
    paths: Mapped[list["PackagePath"]] = relationship(
        back_populates="package",
        order_by="PackagePath.id",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_packages_title", "title"),
        Index("ix_packages_publish_date", "publish_date"),
    )


class PackagePath(Base):
    """包的一条分类路径：l1 必填，l2/l3 可空（链关系在服务层校验）。"""

    __tablename__ = "package_paths"

    id: Mapped[int] = mapped_column(primary_key=True)
    package_id: Mapped[int] = mapped_column(ForeignKey("packages.id", ondelete="CASCADE"), index=True)
    l1_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"), nullable=False)
    l2_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"), nullable=True)
    l3_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"), nullable=True)

    package: Mapped[Package] = relationship(back_populates="paths")

    __table_args__ = (
        UniqueConstraint("package_id", "l1_id", "l2_id", "l3_id", name="uq_package_path"),
    )


class FileItem(Base):
    __tablename__ = "files"

    id: Mapped[int] = mapped_column(primary_key=True)
    package_id: Mapped[int] = mapped_column(ForeignKey("packages.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(500))  # 显示名（默认原文件名）
    format: Mapped[str] = mapped_column(String(20))
    file_path: Mapped[str] = mapped_column(String(1000))  # 相对 data 目录
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    package: Mapped[Package] = relationship(back_populates="files")
    progress: Mapped["ReadingProgress | None"] = relationship(back_populates="file", uselist=False)


class SegmentConfig(Base):
    __tablename__ = "segment_configs"

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(10))  # global / l2 / l3
    # l2 行：l2_id 有值；l3 行：l2_id 与 l3_id 同时有值；global 行：均为空
    l2_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), nullable=True, index=True
    )
    l3_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), nullable=True, index=True
    )
    mode: Mapped[str] = mapped_column(String(20))  # year / n_years / decade / month / custom
    params: Mapped[dict] = mapped_column(JSON, default=dict)

    __table_args__ = (UniqueConstraint("scope", "l2_id", "l3_id", name="uq_segment_scope"),)


class ReadingProgress(Base):
    __tablename__ = "reading_progress"

    file_id: Mapped[int] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    locator: Mapped[dict] = mapped_column(JSON, default=dict)  # {cfi} / {page} / {offset} / {seconds}
    percent: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    file: Mapped[FileItem] = relationship(back_populates="progress")
