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
    mum_group_label: str = Field(default="Mum", min_length=1, max_length=50, description="Group label name (e.g. 'Mum', 'CN', 'MP').")
    description: str | None = Field(default=None)


class PlanningSheetRename(BaseModel):
    version: int | None = None
    name: str = Field(..., min_length=1, max_length=150)


class PlanningSheetGroupLabelUpdate(BaseModel):
    """Correct an existing sheet's group label in place -- see PlanningService.update_mum_group_label."""

    mum_group_label: str = Field(..., min_length=1, max_length=50, description="e.g. 'Mum', 'CN', 'MP', 'Chen'.")


class PlanningSheetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int = 1
    name: str
    description: str | None = None
    position: int
    item_source_type: PlanningColumnSourceType = PlanningColumnSourceType.MANUAL
    item_source_module: str | None = None
    item_source_field: str | None = None
    item_formula_expression: str | None = None
    item_enable_description: bool = False
    item_description: str | None = None
    item_auto_populate_enabled: bool = False
    item_auto_populate_limit: int | None = None
    mum_group_label: str = Field(
        default="Mum",
        description="The word this sheet's group columns use, e.g. 'Mum' in 'Mum 1' / "
        "'NO. OF PKG MUM1', or 'Chen' in 'Chen 1' / 'NO. OF PKG CHEN1'. Set once at sheet "
        "creation/duplication; every fixed-formula, approval-date, and status-history "
        "feature reads this instead of assuming the literal word 'Mum'.",
    )
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class PlanningSheetDuplicate(BaseModel):
    """
    Payload to duplicate an existing sheet's exact structure onto a new one.

    Copies every column (name, data type, position, and full source
    config -- LINKED_LOOKUP module/field, AGGREGATE fn/filters, or FIXED
    formula) from the source sheet onto a brand-new sheet, remapping the
    old sheet's Mum-group label to ``mum_group_label`` wherever it
    appears in a column name (e.g. every "Mum 1" / "Mum1 Remarks" / "NO.
    OF PKG MUM1" becomes "Chen 1" / "Chen1 Remarks" / "NO. OF PKG CHEN1").
    Non-Mum-group columns (Supplier Name, City, PKG QTY, ...) are copied
    with their names unchanged. Rows are never copied -- the new sheet
    starts from Product Master the same way every sheet does (ITEM
    auto-populate), so it doesn't inherit the source sheet's row set.
    """

    name: str = Field(..., min_length=1, max_length=150, description="Name for the new sheet, e.g. 'Chennai branch'.")
    mum_group_label: str = Field(
        default="Mum",
        min_length=1,
        max_length=50,
        description="The word the new sheet's groups should use, e.g. 'Chen' or 'MP'. "
        "Every 'Mum' occurrence in a copied column's name is replaced with this "
        "(case-preserving: 'MUM' -> 'CHEN', 'Mum' -> 'Chen', 'mum' -> 'chen').",
    )
    description: str | None = Field(default=None)


class PlanningItemSourceConfigure(BaseModel):
    """
    Payload to configure the sheet's built-in ITEM column data source.

    Same shape and validation rules as ``PlanningColumnSourceConfigure``
    (see ``PlanningService.configure_item_source``); kept as a separate
    schema since the ITEM column lives on the sheet, not in
    ``planning_columns``.
    """

    source_type: PlanningColumnSourceType
    source_module: str | None = Field(default=None, description="Required for LINKED_LOOKUP, e.g. 'product'.")
    source_field: str | None = Field(default=None, description="Required for LINKED_LOOKUP.")
    formula_expression: str | None = Field(default=None, max_length=2000, description="Required for FORMULA.")
    item_enable_description: bool = Field(
        default=False, description="When set, every row's ITEM cell shows a description button on hover."
    )
    item_auto_populate_enabled: bool = Field(
        default=False, description="Persisted state of the 'Load all records automatically' checkbox."
    )
    item_auto_populate_limit: int | None = Field(
        default=None, ge=1, description="Persisted state of 'How many records to load'. Omit/null for 'All'."
    )


class PlanningItemLinkRecord(BaseModel):
    """Payload to link one row's ITEM cell to a record in the sheet's item_source_module."""

    record_id: uuid.UUID


class PlanningItemAutoPopulate(BaseModel):
    """Payload for bulk-creating rows straight from the ITEM source module, one per record."""

    limit: int | None = Field(
        default=25,
        ge=1,
        description="How many records to pull from the source module (e.g. 25/50/100). Omit or pass null to load ALL records.",
    )
    organization_id: uuid.UUID | None = Field(
        default=None,
        description="Optional Organization filter (Master Data > Organization List). When set, only "
        "records belonging to this organization are eligible to become new rows -- keeps 'Load More "
        "Products' consistent with whatever Organization filter is active in the grid. Only meaningful "
        "when the ITEM source module is 'product'; ignored otherwise.",
    )


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
    enable_description: bool = False
    description: str | None = None
    auto_populate_enabled: bool = False
    auto_populate_limit: int | None = None
    enable_status_color: bool = False
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
    enable_description: bool = Field(
        default=False, description="When set, every cell in this column shows a description button on hover."
    )
    auto_populate_enabled: bool = Field(
        default=False, description="Persisted state of the 'Load all records automatically' checkbox."
    )
    auto_populate_limit: int | None = Field(
        default=None, ge=1, description="Persisted state of 'How many records to load'. Omit/null for 'All'."
    )


class PlanningColumnLinkRecord(BaseModel):
    """Payload to link one row's cell (under a LINKED_LOOKUP column) to a record in the source module."""

    record_id: uuid.UUID


class PlanningColumnRoleLockUpdate(BaseModel):
    """Payload to set (or clear, with an empty list) the roles allowed to edit one column."""

    role_ids: list[uuid.UUID] = Field(default_factory=list)


class PlanningColumnStatusColorToggle(BaseModel):
    """
    Payload to opt a column in/out of carrying CRM-style cell status colors.

    Off by default for every column (including pre-existing ones) -- a
    cell in a column with this False cannot have a status_color set at
    all, and the status-dot button is hidden entirely in the UI.
    """

    enable_status_color: bool


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
    description: str | None = None
    updated_by: uuid.UUID | None = None
    updated_at: datetime


class PlanningRowRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    sheet_id: uuid.UUID
    label: str
    position: int
    linked_record_id: uuid.UUID | None = None
    description: str | None = None
    created_by: uuid.UUID
    updated_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    cells: list[PlanningCellRead] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Grid (one full sheet: columns + rows + cells in one response)
# ---------------------------------------------------------------------------


class PlanningGridRead(BaseModel):
    """
    One page of a sheet's grid.

    ``rows`` holds only ``limit`` rows starting at ``offset`` -- see
    GET /planning/sheets/{sheet_id}/grid?offset=&limit= -- while
    ``total_rows`` is the true, sheet-wide row count, so the frontend can
    show "Showing 1-50 of N" and know whether another page remains.
    """

    sheet: PlanningSheetRead
    columns: list[PlanningColumnRead]
    rows: list[PlanningRowRead]
    total_rows: int
    offset: int
    limit: int | None


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


class PlanningCellDescriptionUpdate(BaseModel):
    """
    Set or clear a cell's free-text description.

    Independent of the cell's value/status -- only meaningful (shown in
    the UI) when the cell's column has enable_description set, but can be
    written regardless.
    """

    description: str | None = Field(default=None, max_length=10000)


class PlanningRowDescriptionUpdate(BaseModel):
    """Set or clear a row's ITEM-cell free-text description. Mirrors PlanningCellDescriptionUpdate for the built-in ITEM column."""

    description: str | None = Field(default=None, max_length=10000)


class PlanningColumnDescriptionUpdate(BaseModel):
    """
    Set or clear a column's single header-level free-text note.

    Lives on the column header (pencil icon), not per-cell -- one note
    describes the whole column (e.g. "Mum 3 covers the July batch").
    """

    description: str | None = Field(default=None, max_length=10000)


class PlanningItemDescriptionUpdate(BaseModel):
    """Set or clear the sheet's built-in ITEM column header-level note. Mirrors PlanningColumnDescriptionUpdate."""

    description: str | None = Field(default=None, max_length=10000)


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


class MumColumnStatusHistoryEntry(BaseModel):
    """One status-color change on a Mum-series column, for the Approval Date hover feed."""

    column_id: uuid.UUID
    column_name: str
    old_status: str | None = None
    new_status: str | None = None
    changed_at: datetime
    changed_by_username: str