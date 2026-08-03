"""
Audit Repository.

Wraps :class:`BaseRepository` for :class:`AuditLog`, opting into the
Phase 2.5 paginated-list framework for the admin-facing "browse audit
trail" API, and explicitly disabling ``update``/``delete`` so the append-
only guarantee ("audit logs must never be deleted") is enforced at the
persistence layer, not just by omission in the service/routes above it.
"""

from __future__ import annotations

from typing import Any, NoReturn

from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditLog
from app.common.base_repository import BaseRepository
from app.core.exceptions import ForbiddenException


class AuditRepository(BaseRepository[AuditLog]):
    """Append-only repository for :class:`AuditLog`. Supports ``create``/``get``/``list`` only."""

    searchable_fields: tuple[str, ...] = ("module", "entity_type", "endpoint", "description")
    sortable_fields: tuple[str, ...] = ("created_at", "action", "module")
    filterable_fields: tuple[str, ...] = (
        "user_id",
        "action",
        "module",
        "entity_type",
        "entity_id",
        "response_status",
    )

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, AuditLog)

    async def update(self, instance: AuditLog, **field_values: Any) -> NoReturn:
        """Audit logs are immutable. Always raises."""
        raise ForbiddenException("Audit log entries cannot be modified.")

    async def delete(self, instance: AuditLog) -> NoReturn:
        """Audit logs must never be deleted, per the Phase 3 retention requirement. Always raises."""
        raise ForbiddenException("Audit log entries cannot be deleted.")
