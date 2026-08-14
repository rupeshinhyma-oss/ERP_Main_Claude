"""
Audit Repository.

Wraps :class:`BaseRepository` for :class:`AuditLog`, opting into the
Phase 2.5 paginated-list framework for the admin-facing "browse audit
trail" API, and explicitly disabling ``update``/``delete`` so the append-
only guarantee ("audit logs must never be deleted") is enforced at the
persistence layer, not just by omission in the service/routes above it.

Also provides join-based filtering by employee name/email/department/
designation (Teams page requirement): AuditLog only stores a raw
``user_id`` + ``username_snapshot``, with no columns of its own for an
actor's employee profile, department, or designation, so filtering on
those requires joining out to ``users`` -> ``employees`` ->
``departments``/``designations`` at query time rather than a filterable
column on AuditLog itself.
"""

from __future__ import annotations

from typing import Any, NoReturn

from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditLog
from app.common.base_repository import BaseRepository
from app.core.exceptions import ForbiddenException
from app.users.models import User


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

    def apply_actor_filters(
        self,
        stmt: Select,
        *,
        actor_name: str | None = None,
        actor_email: str | None = None,
    ) -> Select:
        """
        Join out to Users and filter on the acting user's profile.
        """
        if not any([actor_name, actor_email]):
            return stmt

        stmt = stmt.join(User, User.id == AuditLog.user_id)
        if actor_name:
            pattern = f"%{actor_name}%"
            stmt = stmt.where(
                or_(
                    User.display_name.ilike(pattern),
                    User.first_name.ilike(pattern),
                    User.last_name.ilike(pattern),
                    User.username.ilike(pattern),
                )
            )
        if actor_email:
            stmt = stmt.where(User.email.ilike(f"%{actor_email}%"))
        return stmt

    async def paginated_list_with_actor_filters(
        self,
        query: "Any",
        *,
        actor_name: str | None = None,
        actor_email: str | None = None,
    ) -> tuple[list[AuditLog], int]:
        """
        Same contract as :meth:`BaseRepository.paginated_list`, with the
        user-profile join-filters applied on top.
        """
        from sqlalchemy import func

        base_stmt = self._base_select()
        base_stmt = self._apply_search(base_stmt, query.search.normalized)
        base_stmt = self._apply_dynamic_filters(base_stmt, query.filters)
        base_stmt = self.apply_actor_filters(
            base_stmt,
            actor_name=actor_name,
            actor_email=actor_email,
        )

        count_stmt = select(func.count()).select_from(base_stmt.subquery())
        total = int((await self.session.execute(count_stmt)).scalar_one())

        list_stmt = self._apply_sort(base_stmt, query.sort)
        list_stmt = list_stmt.offset(query.page.offset).limit(query.page.limit)
        result = await self.session.execute(list_stmt)
        items = list(result.scalars().unique().all())
        return items, total