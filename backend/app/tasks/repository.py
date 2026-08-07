"""
Task Repository.

Query-specific extensions for database operations on tasks.
"""

from __future__ import annotations

import uuid
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.base_repository import BaseRepository
from app.tasks.models import Task, TaskPriority, TaskStatus


class TaskRepository(BaseRepository[Task]):
    """Repository for task rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to DB session operating on Task model."""
        super().__init__(session, Task)

    async def list_tasks(
        self,
        *,
        offset: int = 0,
        limit: int = 20,
        status: TaskStatus | None = None,
        priority: TaskPriority | None = None,
        assigned_to_id: uuid.UUID | None = None,
        created_by_id: uuid.UUID | None = None,
        search_query: str | None = None,
    ) -> tuple[list[Task], int]:
        """Fetch tasks with filtering, search query, and pagination."""
        stmt = select(Task).options(
            selectinload(Task.assigned_to),
            selectinload(Task.created_by),
        )

        filters = []
        if status is not None:
            filters.append(Task.status == status)
        if priority is not None:
            filters.append(Task.priority == priority)
        if assigned_to_id is not None:
            filters.append(Task.assigned_to_id == assigned_to_id)
        if created_by_id is not None:
            filters.append(Task.created_by_id == created_by_id)
        if search_query:
            pattern = f"%{search_query.strip()}%"
            filters.append(
                or_(
                    Task.title.ilike(pattern),
                    Task.description.ilike(pattern),
                )
            )

        if filters:
            stmt = stmt.where(*filters)

        # Count total matches
        count_stmt = select(func.count()).select_from(stmt.subquery())
        total = (await self.session.execute(count_stmt)).scalar() or 0

        # Order by created_at descending
        stmt = stmt.order_by(Task.created_at.desc()).offset(offset).limit(limit)
        results = await self.session.execute(stmt)
        return list(results.scalars().all()), total

    async def get_with_users(self, task_id: uuid.UUID) -> Task | None:
        """Fetch task by ID with assigned_to and created_by eagerly loaded."""
        stmt = (
            select(Task)
            .where(Task.id == task_id)
            .options(
                selectinload(Task.assigned_to),
                selectinload(Task.created_by),
            )
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()
