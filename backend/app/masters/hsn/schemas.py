"""HSN Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class HsnCreate(BaseModel):
    """Payload to create a new HSN code."""

    code: str = Field(..., min_length=1, max_length=20)
    description: str | None = None
    gst_percent: float = Field(default=0, ge=0, le=100)
    refund_vat_percent: float = Field(default=0, ge=0, le=100)
    status: RecordStatus = RecordStatus.ACTIVE


class HsnUpdate(BaseModel):
    """Payload to update an existing HSN code. All fields optional (partial update)."""

    code: str | None = Field(default=None, min_length=1, max_length=20)
    description: str | None = None
    gst_percent: float | None = Field(default=None, ge=0, le=100)
    refund_vat_percent: float | None = Field(default=None, ge=0, le=100)
    status: RecordStatus | None = None


class HsnRead(BaseModel):
    """An HSN code, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    description: str | None
    gst_percent: float
    refund_vat_percent: float | None = 0.0
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
    in_file_duplicate_count: int = 0
    in_file_duplicates: list[dict] = []
