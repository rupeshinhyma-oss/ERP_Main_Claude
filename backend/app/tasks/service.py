"""
Task Service.

Business logic for managing tasks, assignment, status transitions, and audit records.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from app.core.exceptions import NotFoundException
from app.tasks.models import Task, TaskPriority, TaskStatus, TaskVisibility
from app.tasks.repository import TaskRepository
from app.users.repository import UserRepository


class TaskService:
    """Orchestrates task management on top of TaskRepository and UserRepository."""

    def __init__(self, task_repository: TaskRepository, user_repository: UserRepository) -> None:
        self.task_repository = task_repository
        self.user_repository = user_repository

    async def get_by_id_or_raise(self, task_id: uuid.UUID) -> Task:
        """Fetch a task by ID or raise NotFoundException."""
        task = await self.task_repository.get_with_users(task_id)
        if task is None:
            raise NotFoundException(f"Task with ID {task_id} not found.")
        return task

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
        current_user_id: uuid.UUID | None = None,
        is_admin: bool = False,
    ) -> tuple[list[Task], int]:
        """List tasks with filters and total count."""
        return await self.task_repository.list_tasks(
            offset=offset,
            limit=limit,
            status=status,
            priority=priority,
            assigned_to_id=assigned_to_id,
            created_by_id=created_by_id,
            search_query=search_query,
            current_user_id=current_user_id,
            is_admin=is_admin,
        )

    async def create_task(
        self,
        *,
        title: str,
        description: str | None,
        priority: TaskPriority,
        visibility: TaskVisibility = TaskVisibility.PRIVATE,
        due_date: datetime | None,
        assigned_to_id: uuid.UUID | None,
        created_by_id: uuid.UUID,
        related_entity_type: str | None = None,
        related_entity_id: str | None = None,
    ) -> Task:
        """Create a new task."""
        if assigned_to_id is not None:
            assignee = await self.user_repository.get_by_id(assigned_to_id)
            if assignee is None:
                raise NotFoundException(f"Assignee user with ID {assigned_to_id} not found.")

        task = await self.task_repository.create(
            title=title,
            description=description,
            status=TaskStatus.PENDING,
            priority=priority,
            visibility=visibility,
            due_date=due_date,
            assigned_to_id=assigned_to_id,
            created_by_id=created_by_id,
            related_entity_type=related_entity_type,
            related_entity_id=related_entity_id,
        )
        return await self.get_by_id_or_raise(task.id)

    async def update_task(
        self,
        task_id: uuid.UUID,
        *,
        title: str | None = None,
        description: str | None = None,
        status: TaskStatus | None = None,
        priority: TaskPriority | None = None,
        visibility: TaskVisibility | None = None,
        due_date: datetime | None = None,
        assigned_to_id: uuid.UUID | None = None,
        related_entity_type: str | None = None,
        related_entity_id: str | None = None,
    ) -> Task:
        """Update an existing task."""
        task = await self.get_by_id_or_raise(task_id)

        if assigned_to_id is not None and assigned_to_id != task.assigned_to_id:
            assignee = await self.user_repository.get_by_id(assigned_to_id)
            if assignee is None:
                raise NotFoundException(f"Assignee user with ID {assigned_to_id} not found.")

        kwargs = {}
        if title is not None: kwargs["title"] = title
        if description is not None: kwargs["description"] = description
        if status is not None: kwargs["status"] = status
        if priority is not None: kwargs["priority"] = priority
        if visibility is not None: kwargs["visibility"] = visibility
        if due_date is not None: kwargs["due_date"] = due_date
        if assigned_to_id is not None: kwargs["assigned_to_id"] = assigned_to_id
        if related_entity_type is not None: kwargs["related_entity_type"] = related_entity_type
        if related_entity_id is not None: kwargs["related_entity_id"] = related_entity_id

        if kwargs:
            await self.task_repository.update(task, **kwargs)
        return await self.get_by_id_or_raise(task_id)

    async def delete_task(self, task_id: uuid.UUID) -> bool:
        """Delete a task by ID."""
        task = await self.get_by_id_or_raise(task_id)
        await self.task_repository.delete(task)
        return True
