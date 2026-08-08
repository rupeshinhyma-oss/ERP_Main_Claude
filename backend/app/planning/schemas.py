"""Shipment Planning Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.planning.models import (
    PlanningCellStatusColor,
    PlanningChangeAction,
    PlanningColumnDataType,
    PlanningColumnSourceType,
)

# ---------------------------------------------------------------------------
# Sheets (branch tabs)
# ---------------------------------------------------------------------------


class PlanningSheetCreate(BaseModel):
    """Payload to create a new sheet (branch tab)."""

    name: str = Field(..., min_length=1, max_length=150, description="e.g. 'Mum Branch'.")
    description: str | None = Field(default=None)


class PlanningSheetRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)


class PlanningSheetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    position: int
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Columns (admin-defined, unlimited, insertable at any position)
# ---------------------------------------------------------------------------


class PlanningColumnCreate(BaseModel):
    """
    Payload to add a new column.

    ``position`` is 0-based and optional -- omit it to append at the end,
    or supply it to insert anywhere, e.g. between "Mum 42 Remarks" and
    "Supplier Name". There is no limit on how many columns can be added,
    and the admin names the column however they want.
    """

    name: str = Field(..., min_length=1, max_length=150, description="Admin-chosen name, e.g. 'Mum 43'.")
    data_type: PlanningColumnDataType = Field(default=PlanningColumnDataType.TEXT)
    position: int | None = Field(default=None, ge=0)


class PlanningColumnRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)


class PlanningColumnMove(BaseModel):
    position: int = Field(..., ge=0)


class PlanningColumnRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sheet_id: uuid.UUID
    name: str
    data_type: PlanningColumnDataType
    position: int
    is_locked: bool
    source_type: PlanningColumnSourceType
    source_module: str | None = None
    source_field: str | None = None
    source_aggregate_fn: str | None = None
    source_aggregate_filters: dict | None = None
    formula_expression: str | None = None
    created_by: uuid.UUID
    updated_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class PlanningColumnSourceConfigure(BaseModel):
    """
    Payload to turn a column MANUAL / LINKED_LOOKUP / AGGREGATE / FORMULA, or reconfigure it.

    Which of the other fields are required depends on ``source_type``;
    the service layer validates the combination (see
    ``PlanningService.configure_column_source``) rather than duplicating
    those rules here as conditionally-required fields, which pydantic
    can't express cleanly for a 4-way variant like this.
    """

    source_type: PlanningColumnSourceType
    source_module: str | None = Field(default=None, description="Required for LINKED_LOOKUP/AGGREGATE, e.g. 'product'.")
    source_field: str | None = Field(default=None, description="Required for LINKED_LOOKUP/AGGREGATE.")
    source_aggregate_fn: str | None = Field(
        default=None, description="One of count/sum/avg/min/max. Required for AGGREGATE."
    )
    source_aggregate_filters: dict | None = Field(
        default=None, description="Optional exact-match filters for AGGREGATE, e.g. {'category_id': '...'}."
    )
    formula_expression: str | None = Field(
        default=None, max_length=2000, description="Required for FORMULA, e.g. 'Mum40 * Rate'."
    )


class PlanningColumnLinkRecord(BaseModel):
    """Payload to link one row's cell (under a LINKED_LOOKUP column) to a record in the source module."""

    record_id: uuid.UUID


class PlanningColumnRoleLockUpdate(BaseModel):
    """Payload to set (or clear, with an empty list) the roles allowed to edit one column."""

    role_ids: list[uuid.UUID] = Field(default_factory=list)


class SourceFieldInfo(BaseModel):
    key: str
    label: str
    is_numeric: bool


class SourceModuleInfo(BaseModel):
    key: str
    label: str
    fields: list[SourceFieldInfo]


# ---------------------------------------------------------------------------
# Rows (item lines, unlimited)
# ---------------------------------------------------------------------------


class PlanningRowCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=500, description="e.g. 'ISL350XDAN Flow Wrap machine'.")
    position: int | None = Field(default=None, ge=0)


class PlanningRowRename(BaseModel):
    label: str = Field(..., min_length=1, max_length=500)


class PlanningRowMove(BaseModel):
    position: int = Field(..., ge=0)


class PlanningCellRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    row_id: uuid.UUID
    column_id: uuid.UUID
    value: str | None = None
    display_value: str | None = Field(
        default=None,
        description="The effective value to show: same as `value` for MANUAL columns, computed live "
        "(lookup/aggregate/formula result) for the other three source types.",
    )
    status_color: PlanningCellStatusColor | None = None
    custom_status_tag_id: uuid.UUID | None = None
    linked_record_id: uuid.UUID | None = None
    updated_by: uuid.UUID | None = None
    updated_at: datetime


class PlanningRowRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sheet_id: uuid.UUID
    label: str
    position: int
    created_by: uuid.UUID
    updated_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    cells: list[PlanningCellRead] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Grid (one full sheet: columns + rows + cells in one response)
# ---------------------------------------------------------------------------


class PlanningGridRead(BaseModel):
    """Everything needed to render one sheet's grid in a single response."""

    sheet: PlanningSheetRead
    columns: list[PlanningColumnRead]
    rows: list[PlanningRowRead]


# ---------------------------------------------------------------------------
# Cell writes
# ---------------------------------------------------------------------------


class PlanningCellValueUpdate(BaseModel):
    value: str | None = Field(default=None, max_length=10000)


class PlanningCellStatusUpdate(BaseModel):
    """
    Attach or clear a CRM-style status tag on a cell.

    Send ``status_color: null`` to clear. Any cell can carry a status tag
    -- it isn't restricted to a particular column.
    """

    status_color: PlanningCellStatusColor | None = None
    custom_status_tag_id: uuid.UUID | None = Field(
        default=None, description="Required when status_color is 'custom'."
    )


# ---------------------------------------------------------------------------
# Status tags (admin-defined custom colors beyond the 3 built-ins)
# ---------------------------------------------------------------------------


class PlanningStatusTagCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=100, description="e.g. 'Delayed'.")
    hex_color: str = Field(..., min_length=7, max_length=7, description="e.g. '#F97316'.")


class PlanningStatusTagRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str
    hex_color: str
    created_by: uuid.UUID
    created_at: datetime


# ---------------------------------------------------------------------------
# Change history (who/when)
# ---------------------------------------------------------------------------


class PlanningChangeLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    sheet_id: uuid.UUID
    row_id: uuid.UUID | None = None
    column_id: uuid.UUID | None = None
    cell_id: uuid.UUID | None = None
    action: PlanningChangeAction
    changed_by: uuid.UUID
    changed_by_username_snapshot: str
    old_value: str | None = None
    new_value: str | None = None
    description: str | None = None