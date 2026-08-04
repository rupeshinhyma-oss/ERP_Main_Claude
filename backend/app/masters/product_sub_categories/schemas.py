"""Product Sub-Category Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class ProductSubCategoryCreate(BaseModel):
    """Payload to create a new product sub-category."""

    category_id: uuid.UUID
    code: str | None = Field(default=None, max_length=50)
    name: str = Field(..., min_length=1, max_length=150)
    description: str | None = None
    status: RecordStatus = RecordStatus.ACTIVE


class ProductSubCategoryUpdate(BaseModel):
    """Payload to update an existing product sub-category. All fields optional (partial update)."""

    category_id: uuid.UUID | None = None
    code: str | None = Field(default=None, min_length=1, max_length=50)
    name: str | None = Field(default=None, min_length=1, max_length=150)
    description: str | None = None
    status: RecordStatus | None = None


class ProductSubCategoryRead(BaseModel):
    """A product sub-category, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    category_id: uuid.UUID
    code: str
    name: str
    description: str | None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class ImportSummaryRead(BaseModel):
    """Result summary returned after a CSV/Excel import."""

    total_rows: int
    created: int
    failed: int
    errors: list[dict]
