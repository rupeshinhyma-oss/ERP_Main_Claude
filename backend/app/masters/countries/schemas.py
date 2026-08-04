"""Country Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class CountryCreate(BaseModel):
    """Payload to create a new country."""

    name: str = Field(..., min_length=1, max_length=150)
    code: str = Field(..., min_length=1, max_length=10)
    iso2: str | None = Field(default=None, max_length=2)
    iso3: str | None = Field(default=None, max_length=3)
    phone_code: str | None = Field(default=None, max_length=10)
    nationality: str | None = Field(default=None, max_length=100)
    currency: str | None = Field(default=None, max_length=10)
    status: RecordStatus = RecordStatus.ACTIVE


class CountryUpdate(BaseModel):
    """Payload to update an existing country. All fields optional (partial update)."""

    name: str | None = Field(default=None, min_length=1, max_length=150)
    code: str | None = Field(default=None, min_length=1, max_length=10)
    iso2: str | None = Field(default=None, max_length=2)
    iso3: str | None = Field(default=None, max_length=3)
    phone_code: str | None = Field(default=None, max_length=10)
    nationality: str | None = Field(default=None, max_length=100)
    currency: str | None = Field(default=None, max_length=10)
    status: RecordStatus | None = None


class CountryRead(BaseModel):
    """A country, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    code: str
    iso2: str | None
    iso3: str | None
    phone_code: str | None
    nationality: str | None
    currency: str | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class ImportSummaryRead(BaseModel):
    """Result summary returned after a CSV/Excel import.

    ``duplicates`` holds every row that collided with an existing record
    (a subset of ``failed``), each with its full original row data and --
    when available -- the existing record it collided with, so the client
    can render a side-by-side comparison instead of just an error string.
    """

    total_rows: int
    created: int
    failed: int
    duplicate_count: int = 0
    errors: list[dict]
    duplicates: list[dict] = []
