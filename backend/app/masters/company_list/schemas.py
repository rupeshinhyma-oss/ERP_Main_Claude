"""Company List Pydantic Schemas."""

from __future__ import annotations

import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class CompanyCreate(BaseModel):
    """Payload to create a new MasterCompany."""

    name: str = Field(..., min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=50)
    description: str | None = Field(default=None, max_length=500)
    status: RecordStatus = RecordStatus.ACTIVE


class CompanyUpdate(BaseModel):
    """Payload to update an existing MasterCompany."""

    name: str | None = Field(default=None, min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=50)
    description: str | None = Field(default=None, max_length=500)
    status: RecordStatus | None = None


class CompanyRead(BaseModel):
    """Response schema for a MasterCompany."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    code: str
    description: str | None = None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class ImportSummaryRead(BaseModel):
    """Summary response for bulk import operations."""

    created: int
    failed: int
    errors: list[str] = []
