"""
Task Dependencies.

Dependency wiring for TaskService.
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.session import get_db_session
from app.tasks.repository import TaskRepository
from app.tasks.service import TaskService
from app.users.repository import UserRepository


def get_task_service(db: AsyncSession = Depends(get_db_session)) -> TaskService:
    """Build a request-scoped TaskService."""
    return TaskService(
        task_repository=TaskRepository(db),
        user_repository=UserRepository(db),
    )
