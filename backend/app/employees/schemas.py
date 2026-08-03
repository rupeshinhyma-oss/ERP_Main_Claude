"""Employees Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.employees.models import EmploymentStatus, EmploymentType, Gender


class EmployeeCreate(BaseModel):
    """Payload to create a new employee profile."""

    first_name: str = Field(..., min_length=1, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str = Field(..., min_length=1, max_length=100)
    display_name: str | None = Field(
        default=None, max_length=200, description="Defaults to 'First Last' if omitted."
    )

    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)
    emergency_contact: str | None = Field(default=None, max_length=255)

    date_of_birth: date | None = None
    gender: Gender | None = None
    date_of_joining: date

    department_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None

    employment_type: EmploymentType = EmploymentType.FULL_TIME

    profile_picture_url: str | None = Field(default=None, max_length=500)

    address: str | None = None
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, max_length=20)

    notes: str | None = None

    user_id: uuid.UUID | None = Field(default=None, description="Optionally link an existing user account.")

    @model_validator(mode="after")
    def _default_display_name(self) -> "EmployeeCreate":
        """Fill ``display_name`` from first/last name when the caller doesn't supply one."""
        if not self.display_name:
            parts = [self.first_name, self.middle_name, self.last_name]
            self.display_name = " ".join(p for p in parts if p)
        return self


class EmployeeUpdate(BaseModel):
    """Payload to update an employee's profile fields. All fields optional (partial update)."""

    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    display_name: str | None = Field(default=None, max_length=200)

    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=30)
    emergency_contact: str | None = Field(default=None, max_length=255)

    date_of_birth: date | None = None
    gender: Gender | None = None
    date_of_joining: date | None = None

    employment_type: EmploymentType | None = None

    profile_picture_url: str | None = Field(default=None, max_length=500)

    address: str | None = None
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, max_length=20)

    notes: str | None = None


class EmployeeRead(BaseModel):
    """An employee profile, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    employee_code: str
    first_name: str
    middle_name: str | None
    last_name: str
    display_name: str
    email: str
    phone: str | None
    emergency_contact: str | None
    date_of_birth: date | None
    gender: Gender | None
    date_of_joining: date
    department_id: uuid.UUID | None
    designation_id: uuid.UUID | None
    manager_id: uuid.UUID | None
    employment_type: EmploymentType
    employment_status: EmploymentStatus
    profile_picture_url: str | None
    address: str | None
    city: str | None
    state: str | None
    country: str | None
    postal_code: str | None
    notes: str | None
    user_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None
    updated_by: uuid.UUID | None


class EmployeeDetailRead(EmployeeRead):
    """An employee profile enriched with display names for its linked entities."""

    department_name: str | None = None
    designation_title: str | None = None
    manager_name: str | None = None


class TransferDepartmentRequest(BaseModel):
    """Payload to move an employee to a different department."""

    department_id: uuid.UUID


class ChangeDesignationRequest(BaseModel):
    """Payload to change an employee's designation."""

    designation_id: uuid.UUID


class AssignManagerRequest(BaseModel):
    """Payload to assign (or clear, with ``manager_id: null``) an employee's manager."""

    manager_id: uuid.UUID | None = None


class LinkUserRequest(BaseModel):
    """Payload to link an employee profile to an existing user account."""

    user_id: uuid.UUID
