"""
Task Pydantic Schemas.

Request/response validation schemas for the Task Management module.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field

from app.tasks.models import TaskPriority, TaskStatus


class UserSimpleRead(BaseModel):
    """Minimal user representation for task assignee/creator in responses."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    email: str


class TaskCreate(BaseModel):
    """Payload to create a new task."""

    title: str = Field(..., min_length=1, max_length=200, description="Task title")
    description: str | None = Field(default=None, description="Detailed task description")
    priority: TaskPriority = Field(default=TaskPriority.MEDIUM, description="Task priority level")
    due_date: datetime | None = Field(default=None, description="Target completion timestamp")
    assigned_to_id: uuid.UUID | None = Field(default=None, description="User ID of assignee")
    related_entity_type: str | None = Field(default=None, max_length=50, description="Optional entity category (e.g. supplier)")
    related_entity_id: str | None = Field(default=None, max_length=100, description="Optional entity identifier")


class TaskUpdate(BaseModel):
    """Payload to update an existing task."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None)
    status: TaskStatus | None = Field(default=None)
    priority: TaskPriority | None = Field(default=None)
    due_date: datetime | None = Field(default=None)
    assigned_to_id: uuid.UUID | None = Field(default=None)
    related_entity_type: str | None = Field(default=None, max_length=50)
    related_entity_id: str | None = Field(default=None, max_length=100)


class TaskRead(BaseModel):
    """Task response representation."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    description: str | None = None
    status: TaskStatus
    priority: TaskPriority
    due_date: datetime | None = None
    assigned_to_id: uuid.UUID | None = None
    created_by_id: uuid.UUID | None = None
    related_entity_type: str | None = None
    related_entity_id: str | None = None
    created_at: datetime
    updated_at: datetime

    assigned_to: UserSimpleRead | None = None
    created_by: UserSimpleRead | None = None


class TaskListResponse(BaseModel):
    """Paginated list of tasks."""

    items: list[TaskRead]
    total: int
    offset: int
    limit: int
