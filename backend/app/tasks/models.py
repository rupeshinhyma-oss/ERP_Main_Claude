"""
Task ORM Models.

Defines Task, TaskStatus, and TaskPriority for the Bitrix24 / ERP style task management system.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum as SQLEnum, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.users.models import User


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


class TaskStatus(str, Enum):
    """Closed set of task status states."""

    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    IN_REVIEW = "IN_REVIEW"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class TaskPriority(str, Enum):
    """Closed set of task priority levels."""

    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    URGENT = "URGENT"


class TaskVisibility(str, Enum):
    """Visibility scope for tasks (PUBLIC or PRIVATE)."""

    PUBLIC = "PUBLIC"
    PRIVATE = "PRIVATE"


class Task(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """
    A single task row within the ERP task management module.
    """

    __tablename__ = "tasks"

    title: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TaskStatus] = mapped_column(
        SQLEnum(TaskStatus, native_enum=False), default=TaskStatus.PENDING, nullable=False, index=True
    )
    priority: Mapped[TaskPriority] = mapped_column(
        SQLEnum(TaskPriority, native_enum=False), default=TaskPriority.MEDIUM, nullable=False, index=True
    )
    visibility: Mapped[TaskVisibility] = mapped_column(
        SQLEnum(TaskVisibility, native_enum=False), default=TaskVisibility.PRIVATE, nullable=False, index=True
    )
    due_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

    assigned_to_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    related_entity_type: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    related_entity_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    assigned_to: Mapped[User | None] = relationship("User", foreign_keys=[assigned_to_id], lazy="selectin")
    created_by: Mapped[User | None] = relationship("User", foreign_keys=[created_by_id], lazy="selectin")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Task title={self.title!r} status={self.status.value} priority={self.priority.value}>"
