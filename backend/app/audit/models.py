"""
Audit Log ORM Model.

Owns the ``audit_logs`` table: one row per recorded action across the
entire application. Deliberately does NOT use :class:`TimestampMixin` or
:class:`SoftDeleteMixin` -- an audit row is written once and never updated
or deleted (see :mod:`app.audit.repository`, which refuses to expose
``update``/``delete`` for this model at all), so it only needs a single
``created_at`` and no ``deleted_at``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.audit.constants import AuditAction
from app.database.base import GUID, Base, UUIDPrimaryKeyMixin


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AuditLog(Base, UUIDPrimaryKeyMixin):
    """A single immutable audit trail entry."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_module_entity", "module", "entity_type", "entity_id"),
        Index("ix_audit_logs_user_created", "user_id", "created_at"),
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False, index=True,
        doc="UTC timestamp the action occurred. No updated_at -- audit rows are write-once.",
    )

    # --- Who ---------------------------------------------------------------
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True,
        doc="Actor who performed the action. Null for unauthenticated/system events "
        "(e.g. a failed login for an unknown username).",
    )
    username_snapshot: Mapped[str | None] = mapped_column(
        String(100), nullable=True,
        doc="Username at the time of the action, captured so the audit trail stays "
        "readable even if the user account is later renamed or deleted.",
    )

    # --- What ----------------------------------------------------------------
    action: Mapped[AuditAction] = mapped_column(
        SAEnum(AuditAction, name="audit_action", native_enum=False, length=30),
        nullable=False, index=True,
    )
    module: Mapped[str] = mapped_column(
        String(100), nullable=False, index=True,
        doc="Feature module the action belongs to, e.g. 'users', 'auth', 'rbac', 'queue'.",
    )
    entity_type: Mapped[str | None] = mapped_column(
        String(100), nullable=True, index=True,
        doc="Entity/model name affected, e.g. 'User', 'Role'. Null for non-entity events (login/logout).",
    )
    entity_id: Mapped[str | None] = mapped_column(
        String(100), nullable=True, index=True,
        doc="Primary key of the affected entity, stored as text so any ID shape (UUID, "
        "composite key) can be recorded without a schema change.",
    )

    old_values: Mapped[str | None] = mapped_column(
        Text, nullable=True, doc="Masked, JSON-encoded snapshot of the entity before the change.",
    )
    new_values: Mapped[str | None] = mapped_column(
        Text, nullable=True, doc="Masked, JSON-encoded snapshot of the entity after the change.",
    )

    # --- Request context -----------------------------------------------------
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    http_method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    endpoint: Mapped[str | None] = mapped_column(String(255), nullable=True)
    response_status: Mapped[int | None] = mapped_column(Integer, nullable=True)

    description: Mapped[str | None] = mapped_column(
        String(500), nullable=True, doc="Optional short human-readable summary of the event.",
    )

    def __repr__(self) -> str:
        return f"<AuditLog action={self.action!r} module={self.module!r} entity={self.entity_type!r}:{self.entity_id!r}>"
