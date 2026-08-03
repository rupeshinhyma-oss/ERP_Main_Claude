"""State Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class StateCreate(BaseModel):
    """Payload to create a new state."""

    country_id: uuid.UUID
    name: str = Field(..., min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=20)
    status: RecordStatus = RecordStatus.ACTIVE


class StateUpdate(BaseModel):
    """Payload to update an existing state. All fields optional (partial update)."""

    country_id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=20)
    status: RecordStatus | None = None


class StateRead(BaseModel):
    """A state, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    country_id: uuid.UUID
    name: str
    code: str | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class ImportSummaryRead(BaseModel):
    """Result summary returned after a CSV/Excel import."""

    total_rows: int
    created: int
    failed: int
    errors: list[dict]
