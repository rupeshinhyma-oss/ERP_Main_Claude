"""Currency Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, ConfigDict

from app.core.constants import RecordStatus


class CurrencyCreate(BaseModel):
    """Payload to create a new currency."""

    name: str = Field(..., min_length=1, max_length=100)
    code: str = Field(..., min_length=1, max_length=10)
    symbol: str | None = Field(default=None, max_length=10)
    decimal_places: int = Field(default=2, ge=0, le=6)
    status: RecordStatus = RecordStatus.ACTIVE


class CurrencyUpdate(BaseModel):
    """Payload to update an existing currency. All fields optional (partial update)."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    code: str | None = Field(default=None, min_length=1, max_length=10)
    symbol: str | None = Field(default=None, max_length=10)
    decimal_places: int | None = Field(default=None, ge=0, le=6)
    status: RecordStatus | None = None


class CurrencyRead(BaseModel):
    """A currency, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    code: str
    symbol: str | None
    decimal_places: int
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class ImportSummaryRead(BaseModel):
    """Result summary returned after a CSV/Excel import."""

    total_rows: int
    created: int
    failed: int
    errors: list[dict]
