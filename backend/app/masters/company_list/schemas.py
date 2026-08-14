"""Company List Pydantic Schemas."""

from __future__ import annotations

import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field

from app.core.constants import RecordStatus


class CompanyBranch(BaseModel):
    """Schema for an operating branch of a company."""

    id: str = Field(..., description="Unique branch ID")
    name: str = Field(..., description="Branch / Location name e.g. Gujarat / Ahmedabad, Mumbai")
    code_prefix: str = Field(..., description="Consignment code prefix e.g. ING, INM, INI")
    address: str | None = None
    city: str | None = None
    status: str = "active"


class CompanyCreate(BaseModel):
    """Payload to create a new MasterCompany."""

    name: str = Field(..., min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=50)
    description: str | None = Field(default=None, max_length=500)
    branches: list[CompanyBranch] | None = None
    status: RecordStatus = RecordStatus.ACTIVE


class CompanyUpdate(BaseModel):
    """Payload to update an existing MasterCompany."""

    name: str | None = Field(default=None, min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=50)
    description: str | None = Field(default=None, max_length=500)
    branches: list[CompanyBranch] | None = None
    status: RecordStatus | None = None


class CompanyRead(BaseModel):
    """Response schema for a MasterCompany."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    code: str
    description: str | None = None
    branches: list[CompanyBranch] | None = None
    status: RecordStatus
    created_at: datetime
    updated_at: datetime


class ImportSummaryRead(BaseModel):
    """Summary response for bulk import operations."""

    created: int
    failed: int
    errors: list[str] = []
