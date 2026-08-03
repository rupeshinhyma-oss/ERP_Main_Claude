"""Designations Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class DesignationCreate(BaseModel):
    """Payload to create a new designation."""

    code: str = Field(..., min_length=1, max_length=50)
    title: str = Field(..., min_length=1, max_length=150)
    description: str | None = None
    level: int | None = Field(default=None, ge=0, le=100)
    status: RecordStatus = RecordStatus.ACTIVE


class DesignationUpdate(BaseModel):
    """Payload to update an existing designation. All fields optional (partial update)."""

    code: str | None = Field(default=None, min_length=1, max_length=50)
    title: str | None = Field(default=None, min_length=1, max_length=150)
    description: str | None = None
    level: int | None = Field(default=None, ge=0, le=100)
    status: RecordStatus | None = None


class DesignationRead(BaseModel):
    """A designation, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    title: str
    description: str | None
    level: int | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime
