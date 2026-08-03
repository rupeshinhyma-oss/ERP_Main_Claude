"""City Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class CityCreate(BaseModel):
    """Payload to create a new city."""

    country_id: uuid.UUID
    state_id: uuid.UUID
    name: str = Field(..., min_length=1, max_length=150)
    status: RecordStatus = RecordStatus.ACTIVE


class CityUpdate(BaseModel):
    """Payload to update an existing city. All fields optional (partial update)."""

    country_id: uuid.UUID | None = None
    state_id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=150)
    status: RecordStatus | None = None


class CityRead(BaseModel):
    """A city, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    country_id: uuid.UUID
    state_id: uuid.UUID
    name: str
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class ImportSummaryRead(BaseModel):
    """Result summary returned after a CSV/Excel import."""

    total_rows: int
    created: int
    failed: int
    errors: list[dict]
