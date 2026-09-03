"""
Organization Structure Pydantic Schemas -- Position and every remaining assignment table.

Department schemas (DepartmentCreate/Update/Read, DepartmentAssignmentCreate/Read)
were merged into ``app.rbac.schemas`` (RoleCreate/Update/Read now carry
``code``/``parent_department_id``; ``app.users.schemas.AssignRoleRequest``
now carries assignment-type/effective-date fields) -- see the Department/Role
merge notes in ``app.rbac.models``.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Any

from app.org_structure.models import (
    LeadershipType,
    OrgRecordStatus,
    PositionAssignmentType,
    ReportingRelationshipType,
)


# --- Position -------------------------------------------------------------------------
class PositionCreate(BaseModel):
    """Payload to create a new position/designation."""

    name: str = Field(..., min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=50)
    description: str | None = None
    status: OrgRecordStatus = OrgRecordStatus.ACTIVE

    @field_validator("status", mode="before")
    @classmethod
    def _coerce_status(cls, v: Any) -> Any:
        if isinstance(v, str):
            v_upper = v.strip().upper()
            if v_upper in OrgRecordStatus.__members__:
                return OrgRecordStatus[v_upper]
        return v


class PositionUpdate(BaseModel):
    """Payload to update a position. All fields optional (partial update)."""

    name: str | None = Field(default=None, min_length=1, max_length=150)
    code: str | None = Field(default=None, max_length=50)
    description: str | None = None
    status: OrgRecordStatus | None = None

    @field_validator("status", mode="before")
    @classmethod
    def _coerce_status(cls, v: Any) -> Any:
        if isinstance(v, str):
            v_upper = v.strip().upper()
            if v_upper in OrgRecordStatus.__members__:
                return OrgRecordStatus[v_upper]
        return v


class PositionRead(BaseModel):
    """A position/designation, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    code: str | None = None
    description: str | None = None
    status: OrgRecordStatus
    employee_count: int = 0
    created_at: datetime
    updated_at: datetime


# --- Employee <-> Position assignment --------------------------------------------------
class PositionAssignmentCreate(BaseModel):
    """Payload to assign an employee to a position."""

    employee_id: uuid.UUID
    position_id: uuid.UUID
    department_id: uuid.UUID | None = None
    assignment_type: PositionAssignmentType = PositionAssignmentType.PRIMARY
    is_primary: bool = False
    effective_from: date | None = None
    effective_to: date | None = None


class PositionAssignmentRead(BaseModel):
    """An employee<->position assignment, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    employee_id: uuid.UUID
    position_id: uuid.UUID
    department_id: uuid.UUID | None = None
    assignment_type: PositionAssignmentType
    is_primary: bool
    effective_from: date | None = None
    effective_to: date | None = None
    status: OrgRecordStatus
    created_at: datetime


# --- Department Leadership --------------------------------------------------------------
class LeadershipAssignmentCreate(BaseModel):
    """Payload to assign an employee a leadership role over a department."""

    department_id: uuid.UUID
    employee_id: uuid.UUID
    leadership_type: LeadershipType = LeadershipType.PRIMARY_MANAGER
    is_primary: bool = False
    enforce_single_primary_manager: bool = True
    effective_from: date | None = None
    effective_to: date | None = None


class LeadershipAssignmentRead(BaseModel):
    """A department leadership assignment, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    department_id: uuid.UUID
    employee_id: uuid.UUID
    leadership_type: LeadershipType
    is_primary: bool
    effective_from: date | None = None
    effective_to: date | None = None
    status: OrgRecordStatus
    created_at: datetime


# --- Reporting Relationships --------------------------------------------------------------
class ReportingRelationshipCreate(BaseModel):
    """Payload to create an employee reporting relationship."""

    employee_id: uuid.UUID
    manager_employee_id: uuid.UUID
    relationship_type: ReportingRelationshipType = ReportingRelationshipType.PRIMARY_REPORTING
    department_id: uuid.UUID | None = None
    is_primary: bool = False
    effective_from: date | None = None
    effective_to: date | None = None


class ReportingRelationshipRead(BaseModel):
    """An employee reporting relationship, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    employee_id: uuid.UUID
    manager_employee_id: uuid.UUID
    relationship_type: ReportingRelationshipType
    department_id: uuid.UUID | None = None
    is_primary: bool
    effective_from: date | None = None
    effective_to: date | None = None
    status: OrgRecordStatus
    created_at: datetime


class ReassignDirectReportsRequest(BaseModel):
    """Payload to move all of a manager's active direct reports to a new manager."""

    to_manager_employee_id: uuid.UUID


class SetPrimaryManagerRequest(BaseModel):
    """Payload to set/move an employee's primary manager in one step (used by the drag-and-drop org chart)."""

    manager_employee_id: uuid.UUID


class OrgChartNode(BaseModel):
    """One node's worth of edge data for the dynamic organization chart (Part 18)."""

    employee_id: uuid.UUID
    employee_name: str
    manager_employee_id: uuid.UUID | None = None
    manager_name: str | None = None
    relationship_id: uuid.UUID | None = None