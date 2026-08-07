"""Product Category Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class ProductCategoryCreate(BaseModel):
    """Payload to create a new product category."""

    code: str | None = Field(default=None, max_length=50)
    name: str = Field(..., min_length=1, max_length=150)
    description: str | None = None
    status: RecordStatus = RecordStatus.ACTIVE


class ProductCategoryUpdate(BaseModel):
    """Payload to update an existing product category. All fields optional (partial update)."""

    code: str | None = Field(default=None, min_length=1, max_length=50)
    name: str | None = Field(default=None, min_length=1, max_length=150)
    description: str | None = None
    status: RecordStatus | None = None


class ProductCategoryRead(BaseModel):
    """A product category, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    description: str | None
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
