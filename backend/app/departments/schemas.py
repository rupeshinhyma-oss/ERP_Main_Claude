"""Departments Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class DepartmentCreate(BaseModel):
    """Payload to create a new department."""

    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=150)
    description: str | None = None
    parent_department_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    status: RecordStatus = RecordStatus.ACTIVE


class DepartmentUpdate(BaseModel):
    """Payload to update an existing department. All fields optional (partial update)."""

    code: str | None = Field(default=None, min_length=1, max_length=50)
    name: str | None = Field(default=None, min_length=1, max_length=150)
    description: str | None = None
    parent_department_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None
    status: RecordStatus | None = None


class DepartmentRead(BaseModel):
    """A department, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    description: str | None
    parent_department_id: uuid.UUID | None
    manager_id: uuid.UUID | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime
