"""
Shipment Planning API Routes.

Every write route records its own change-log + audit entry inside
:class:`app.planning.service.PlanningService`, so routes here stay thin --
they just validate permissions, call the service, and shape the response.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.planning.dependencies import get_planning_service
from app.planning.schemas import (
    MumColumnStatusHistoryEntry,
    PlanningCellDescriptionUpdate,
    PlanningCellRead,
    PlanningCellStatusUpdate,
    PlanningCellValueUpdate,
    PlanningChangeLogRead,
    PlanningColumnCreate,
    PlanningColumnLinkRecord,
    PlanningColumnMove,
    PlanningColumnRead,
    PlanningColumnRename,
    PlanningColumnRoleLockUpdate,
    PlanningColumnStatusColorToggle,
    PlanningColumnSourceConfigure,
    PlanningGridRead,
    PlanningItemAutoPopulate,
    PlanningItemLinkRecord,
    PlanningItemSourceConfigure,
    PlanningRowCreate,
    PlanningRowDescriptionUpdate,
    PlanningRowMove,
    PlanningRowRead,
    PlanningRowRename,
    PlanningSheetCreate,
    PlanningSheetRead,
    PlanningSheetRename,
    PlanningStatusTagCreate,
    PlanningStatusTagRead,
    SourceModuleInfo,
)
from app.planning.service import PlanningService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/planning", tags=["Shipment Planning"])


def _row_to_read_dict(row) -> dict:
    """
    Build a PlanningRowRead dict without touching ``row.cells`` directly.

    ``row.cells`` is a lazy-loaded SQLAlchemy relationship. Calling
    ``PlanningRowRead.model_validate(row)`` on a row that was created,
    renamed, or moved (rather than fetched via ``list_for_sheet``'s
    ``selectinload``) makes Pydantic touch that relationship outside an
    active query context, raising ``MissingGreenlet``. A brand-new,
    renamed, or moved row never has its cells populated by these
    operations anyway, so building the dict explicitly with ``cells: []``
    is both correct and avoids the lazy-load entirely.
    """
    return {
        "id": row.id,
        "sheet_id": row.sheet_id,
        "label": row.label,
        "position": row.position,
        "linked_record_id": row.linked_record_id,
        "description": row.description,
        "created_by": row.created_by,
        "updated_by": row.updated_by,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "cells": [],
    }


# ---------------------------------------------------------------------------
# Sheets (branch tabs)
# ---------------------------------------------------------------------------


@router.post("/sheets", status_code=status.HTTP_201_CREATED, summary="Create a planning sheet (branch tab)")
async def create_sheet(
    payload: PlanningSheetCreate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.sheet.manage")),
) -> dict:
    sheet = await service.create_sheet(
        name=payload.name, description=payload.description, user_id=current_user.id, username=current_user.username
    )
    data = PlanningSheetRead.model_validate(sheet).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Sheet created.")


@router.get("/sheets", summary="List planning sheets")
async def list_sheets(
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.read")),
) -> dict:
    sheets = await service.list_sheets()
    data = [PlanningSheetRead.model_validate(s).model_dump(mode="json") for s in sheets]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/sheets/{sheet_id}", summary="Rename a planning sheet")
async def rename_sheet(
    sheet_id: uuid.UUID,
    payload: PlanningSheetRename,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.sheet.manage")),
) -> dict:
    sheet = await service.rename_sheet(sheet_id, name=payload.name, user_id=current_user.id, username=current_user.username)
    data = PlanningSheetRead.model_validate(sheet).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Sheet renamed.")


@router.delete("/sheets/{sheet_id}", summary="Delete a planning sheet")
async def delete_sheet(
    sheet_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.sheet.manage")),
) -> dict:
    await service.delete_sheet(sheet_id, user_id=current_user.id, username=current_user.username)
    return build_success_response(data=None, request_id=request.state.request_id, message="Sheet deleted.")


# ---------------------------------------------------------------------------
# Grid (columns + rows + cells for one sheet, in one call)
# ---------------------------------------------------------------------------


@router.get("/sheets/{sheet_id}/grid", summary="Get a sheet's full grid (columns, rows, cells)")
async def get_grid(
    sheet_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.read")),
) -> dict:
    grid = await service.get_grid(sheet_id)
    columns = grid["columns"]
    rows = grid["rows"]

    # Aggregate columns yield the same value for the whole column, so compute
    # each one exactly once here rather than once per row -- avoids an
    # N-times-redundant query against the source module for a sheet with N rows.
    aggregate_cache: dict[uuid.UUID, str | None] = {}
    for column in columns:
        if column.source_type == "aggregate":
            aggregate_cache[column.id] = await service.compute_cell_display_value(column, None)

    sheet = grid["sheet"]
    row_reads = []
    for row in rows:
        cells_by_column_id = {cell.column_id: cell for cell in row.cells}
        cell_reads = []
        # Iterate every column, not just columns with a stored cell:
        # FORMULA and AGGREGATE columns routinely have no PlanningCell row
        # at all for a given row (direct edits to them are rejected, and
        # nothing auto-creates one), but the frontend still needs one grid
        # entry per (row, column) to render the cell and its computed value.
        for column in columns:
            cell = cells_by_column_id.get(column.id)
            if column.source_type == "aggregate":
                display_value = aggregate_cache.get(column.id)
            else:
                display_value = await service.compute_cell_display_value(column, cell, row_id=row.id)
            if cell is not None:
                cell_data = PlanningCellRead.model_validate(cell).model_dump(mode="json")
            else:
                cell_data = {
                    "id": None,
                    "row_id": str(row.id),
                    "column_id": str(column.id),
                    "value": None,
                    "status_color": None,
                    "custom_status_tag_id": None,
                    "linked_record_id": None,
                    "description": None,
                    "updated_by": None,
                    "updated_at": None,
                }
            cell_data["display_value"] = display_value
            cell_reads.append(cell_data)
        row_data = PlanningRowRead.model_validate(row).model_dump(mode="json")
        row_data["cells"] = cell_reads
        # ITEM is the sheet's built-in first column, not a row in `columns`
        # above -- when the admin has configured it as linked-lookup or
        # formula (see PlanningItemSourceConfigure), show the live computed
        # value instead of the raw stored label, same "never trust a stale
        # value" behavior as every other dynamic column.
        row_data["label"] = await service.compute_row_item_display(sheet, row)
        row_reads.append(row_data)

    data = {
        "sheet": PlanningSheetRead.model_validate(grid["sheet"]).model_dump(mode="json"),
        "columns": [PlanningColumnRead.model_validate(c).model_dump(mode="json") for c in columns],
        "rows": row_reads,
    }
    return build_success_response(data=data, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Columns (admin-defined, unlimited, insertable at any position)
# ---------------------------------------------------------------------------


@router.post("/sheets/{sheet_id}/columns", status_code=status.HTTP_201_CREATED, summary="Add a column")
async def add_column(
    sheet_id: uuid.UUID,
    payload: PlanningColumnCreate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    """
    Add a new, admin-named column to this sheet, at any position.

    There is no limit on how many columns can exist -- keep calling this
    to add "Mum 43", "Mum 44", or anything else the admin wants to track.
    """
    column = await service.add_column(
        sheet_id,
        name=payload.name,
        data_type=payload.data_type,
        position=payload.position,
        user_id=current_user.id,
        username=current_user.username,
    )
    data = PlanningColumnRead.model_validate(column).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Column added.")


@router.patch("/sheets/{sheet_id}/columns/{column_id}", summary="Rename a column")
async def rename_column(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningColumnRename,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    column = await service.rename_column(
        sheet_id, column_id, name=payload.name, user_id=current_user.id, username=current_user.username
    )
    data = PlanningColumnRead.model_validate(column).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Column renamed.")


@router.post("/sheets/{sheet_id}/columns/{column_id}/move", summary="Move a column to a new position")
async def move_column(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningColumnMove,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    column = await service.move_column(
        sheet_id, column_id, new_position=payload.position, user_id=current_user.id, username=current_user.username
    )
    data = PlanningColumnRead.model_validate(column).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Column moved.")


@router.delete("/sheets/{sheet_id}/columns/{column_id}", summary="Delete a column")
async def delete_column(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    await service.delete_column(sheet_id, column_id, user_id=current_user.id, username=current_user.username)
    return build_success_response(data=None, request_id=request.state.request_id, message="Column deleted.")


@router.get("/sheets/{sheet_id}/columns/{column_id}/history", summary="Get a column's change history")
async def get_column_history(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.read")),
) -> dict:
    entries = await service.get_column_history(sheet_id, column_id)
    data = [PlanningChangeLogRead.model_validate(e).model_dump(mode="json") for e in entries]
    return build_success_response(data=data, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Dynamic column sourcing: linked lookup / aggregate / formula
# ---------------------------------------------------------------------------


@router.get("/source-modules", summary="List modules/fields available for linked-lookup and aggregate columns")
async def list_source_modules(
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    """
    Document: "if i wanted to extract data or certain data from Product
    master i can select and extract" -- this is the admin UI's dropdown
    source for which modules/fields are available to pull from.
    """
    data = [SourceModuleInfo(**m).model_dump(mode="json") for m in service.list_available_source_modules()]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.put("/sheets/{sheet_id}/columns/{column_id}/source", summary="Configure a column's data source or formula")
async def configure_column_source(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningColumnSourceConfigure,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    """
    Turn a column MANUAL / LINKED_LOOKUP / AGGREGATE / FORMULA, or edit its config.

    Document: "each column or row new created i can extract data from
    other parts too ... also if i want i can add any calculation
    manually". Subject to the column's optional per-column role lock, on
    top of the ``planning.column.manage`` permission checked above.
    """
    column = await service.configure_column_source(
        sheet_id,
        column_id,
        source_type=payload.source_type,
        source_module=payload.source_module,
        source_field=payload.source_field,
        source_aggregate_fn=payload.source_aggregate_fn,
        source_aggregate_filters=payload.source_aggregate_filters,
        formula_expression=payload.formula_expression,
        enable_description=payload.enable_description,
        auto_populate_enabled=payload.auto_populate_enabled,
        auto_populate_limit=payload.auto_populate_limit,
        user_id=current_user.id,
        username=current_user.username,
    )
    data = PlanningColumnRead.model_validate(column).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Column source configured.")


@router.put("/sheets/{sheet_id}/item-source", summary="Configure the sheet's built-in ITEM column data source")
async def configure_item_source(
    sheet_id: uuid.UUID,
    payload: PlanningItemSourceConfigure,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    """
    Turn the ITEM column MANUAL / LINKED_LOOKUP / FORMULA, or edit its config.

    The ITEM column is the sheet's built-in first column (row identity),
    not an entry in ``planning_columns``, so it gets its own endpoint
    mirroring ``configure_column_source`` above.
    """
    sheet = await service.configure_item_source(
        sheet_id,
        source_type=payload.source_type,
        source_module=payload.source_module,
        source_field=payload.source_field,
        formula_expression=payload.formula_expression,
        item_enable_description=payload.item_enable_description,
        item_auto_populate_enabled=payload.item_auto_populate_enabled,
        item_auto_populate_limit=payload.item_auto_populate_limit,
        user_id=current_user.id,
        username=current_user.username,
    )
    data = PlanningSheetRead.model_validate(sheet).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="ITEM column source configured.")


@router.put(
    "/sheets/{sheet_id}/rows/{row_id}/item-link",
    summary="Link a row's ITEM cell to a record in the sheet's item_source_module",
)
async def link_row_to_item_source_record(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    payload: PlanningItemLinkRecord,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.cell.edit")),
) -> dict:
    """Pick, per row, which record (e.g. which Product) the ITEM column pulls its name from."""
    grid = await service.get_grid(sheet_id)
    row = await service.link_row_to_item_source_record(
        sheet_id, row_id, record_id=payload.record_id, user_id=current_user.id, username=current_user.username
    )
    display_value = await service.compute_row_item_display(grid["sheet"], row)
    data = PlanningRowRead.model_validate(_row_to_read_dict(row)).model_dump(mode="json")
    data["label"] = display_value
    return build_success_response(data=data, request_id=request.state.request_id, message="Row linked.")


@router.post(
    "/sheets/{sheet_id}/item-source/auto-populate",
    status_code=status.HTTP_201_CREATED,
    summary="Bulk-create rows straight from the ITEM source module, one row per record",
)
async def auto_populate_rows_from_item_source(
    sheet_id: uuid.UUID,
    payload: PlanningItemAutoPopulate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.row.manage")),
) -> dict:
    """
    "Load everything from that field's data automatically" -- the checkbox
    next to the manual per-row 🔗 flow. Pulls up to ``limit`` records
    (25/50/100, or every record when ``limit`` is omitted/null) from the
    sheet's configured ITEM source module and creates one already-linked
    row per record, skipping any record already represented by an
    existing row.
    """
    grid = await service.get_grid(sheet_id)
    rows = await service.auto_populate_rows_from_item_source(
        sheet_id, limit=payload.limit, user_id=current_user.id, username=current_user.username
    )
    data = []
    for row in rows:
        row_data = PlanningRowRead.model_validate(_row_to_read_dict(row)).model_dump(mode="json")
        row_data["label"] = await service.compute_row_item_display(grid["sheet"], row)
        data.append(row_data)
    return build_success_response(
        data=data, request_id=request.state.request_id, message=f"Added {len(rows)} row(s)."
    )


@router.put(
    "/sheets/{sheet_id}/rows/{row_id}/columns/{column_id}/link",
    summary="Link a row's cell (under a linked-lookup column) to a record in the source module",
)
async def link_row_to_source_record(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningColumnLinkRecord,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.cell.edit")),
) -> dict:
    """Document: admin picks, per row, which record (e.g. which Product) that row's linked-lookup column pulls from."""
    cell = await service.link_row_to_source_record(
        sheet_id, row_id, column_id, record_id=payload.record_id, user_id=current_user.id, username=current_user.username
    )
    display_value = await service.compute_cell_display_value(
        await service.get_column(sheet_id, column_id), cell, row_id=row_id
    )
    data = PlanningCellRead.model_validate(cell).model_dump(mode="json")
    data["display_value"] = display_value
    return build_success_response(data=data, request_id=request.state.request_id, message="Row linked.")


@router.post(
    "/sheets/{sheet_id}/columns/{column_id}/auto-link",
    status_code=status.HTTP_200_OK,
    summary="Bulk-link every row's cell under this column to the record its ITEM is already linked to",
)
async def auto_link_column_to_item_records(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.cell.edit")),
) -> dict:
    """
    "Load everything from that field's data automatically" for a regular
    linked-lookup column: instead of clicking 🔗 once per row for this
    column too, reuse whatever record each row's ITEM is already linked
    to (only valid when this column and ITEM share the same source
    module).
    """
    cells = await service.auto_link_column_to_item_records(
        sheet_id, column_id, user_id=current_user.id, username=current_user.username
    )
    column = await service.get_column(sheet_id, column_id)
    data = []
    for cell in cells:
        display_value = await service.compute_cell_display_value(column, cell, row_id=cell.row_id)
        cell_data = PlanningCellRead.model_validate(cell).model_dump(mode="json")
        cell_data["display_value"] = display_value
        data.append(cell_data)
    return build_success_response(
        data=data, request_id=request.state.request_id, message=f"Linked {len(cells)} row(s)."
    )





@router.get(
    "/sheets/{sheet_id}/columns/{column_id}/role-lock",
    summary="Get the roles (if any) a column is restricted to",
)
async def get_column_role_lock(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    role_ids = await service.get_column_role_lock_ids(sheet_id, column_id)
    data = {"role_ids": [str(r) for r in role_ids]}
    return build_success_response(data=data, request_id=request.state.request_id)


@router.put(
    "/sheets/{sheet_id}/columns/{column_id}/role-lock",
    summary="Restrict a column's editing to specific roles (empty list clears the restriction)",
)
async def set_column_role_lock(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningColumnRoleLockUpdate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    """
    Document: "admin can also give access based on permission too ...
    keep it flexible" -- an admin with planning.column.manage can lock
    any individual column to one or more roles, on top of the sheet-level
    permission. Passing an empty role_ids list clears the restriction.
    """
    column = await service.set_column_role_lock(
        sheet_id, column_id, role_ids=payload.role_ids, user_id=current_user.id, username=current_user.username
    )
    data = PlanningColumnRead.model_validate(column).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Column role lock updated.")


@router.put(
    "/sheets/{sheet_id}/columns/{column_id}/status-color-enabled",
    summary="Opt a column in/out of carrying CRM-style cell status colors",
)
async def set_column_status_color_enabled(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningColumnStatusColorToggle,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    """
    Controlled from the Columns panel, alongside Visible/Frozen -- unlike
    those two (per-user local display prefs), this is a real structural
    property of the column itself, so it's backend-persisted and visible
    to every user, not just the one who set it.
    """
    column = await service.set_column_status_color_enabled(
        sheet_id, column_id, enabled=payload.enable_status_color, user_id=current_user.id, username=current_user.username
    )
    data = PlanningColumnRead.model_validate(column).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Column status-color setting updated.")


# ---------------------------------------------------------------------------
# Rows (item lines, unlimited)
# ---------------------------------------------------------------------------


@router.post("/sheets/{sheet_id}/rows", status_code=status.HTTP_201_CREATED, summary="Add a row")
async def add_row(
    sheet_id: uuid.UUID,
    payload: PlanningRowCreate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.row.manage")),
) -> dict:
    row = await service.add_row(
        sheet_id, label=payload.label, position=payload.position, user_id=current_user.id, username=current_user.username
    )
    data = PlanningRowRead.model_validate(_row_to_read_dict(row)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Row added.")


@router.patch("/sheets/{sheet_id}/rows/{row_id}", summary="Rename a row")
async def rename_row(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    payload: PlanningRowRename,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.row.manage")),
) -> dict:
    row = await service.rename_row(sheet_id, row_id, label=payload.label, user_id=current_user.id, username=current_user.username)
    data = PlanningRowRead.model_validate(_row_to_read_dict(row)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Row renamed.")


@router.put("/sheets/{sheet_id}/rows/{row_id}/description", summary="Set/clear a row's ITEM-cell free-text description")
async def set_row_description(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    payload: PlanningRowDescriptionUpdate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.cell.edit")),
) -> dict:
    """
    Set or clear a row's ITEM-cell free-text description.

    Mirrors set_cell_description for the built-in ITEM column, which
    lives directly on the row rather than as a separate cell.
    """
    row = await service.set_row_description(
        sheet_id, row_id, description=payload.description, user_id=current_user.id, username=current_user.username
    )
    data = PlanningRowRead.model_validate(_row_to_read_dict(row)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Row description updated.")


@router.post("/sheets/{sheet_id}/rows/{row_id}/move", summary="Move a row to a new position")
async def move_row(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    payload: PlanningRowMove,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.row.manage")),
) -> dict:
    row = await service.move_row(
        sheet_id, row_id, new_position=payload.position, user_id=current_user.id, username=current_user.username
    )
    data = PlanningRowRead.model_validate(_row_to_read_dict(row)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Row moved.")


@router.delete("/sheets/{sheet_id}/rows/{row_id}", summary="Delete a row")
async def delete_row(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.row.manage")),
) -> dict:
    await service.delete_row(sheet_id, row_id, user_id=current_user.id, username=current_user.username)
    return build_success_response(data=None, request_id=request.state.request_id, message="Row deleted.")


@router.get("/sheets/{sheet_id}/rows/{row_id}/history", summary="Get a row's change history")
async def get_row_history(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.read")),
) -> dict:
    entries = await service.get_row_history(sheet_id, row_id)
    data = [PlanningChangeLogRead.model_validate(e).model_dump(mode="json") for e in entries]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get(
    "/sheets/{sheet_id}/rows/{row_id}/mum-status-history",
    summary="Get the Approval Date hover feed: every status-color change on this row's Mum-series columns",
)
async def get_mum_column_status_history(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.read")),
) -> dict:
    """
    Document: "When Mum 45 was blue and when Mum 46 was blue and other
    color too" -- powers the eye/history icon on the Approval Date cell.
    """
    entries = await service.get_mum_column_status_history_for_row(sheet_id, row_id)
    data = [MumColumnStatusHistoryEntry(**e).model_dump(mode="json") for e in entries]
    return build_success_response(data=data, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Cells (value + CRM-style status color, on any cell)
# ---------------------------------------------------------------------------


@router.put("/sheets/{sheet_id}/rows/{row_id}/columns/{column_id}/value", summary="Set a cell's value")
async def set_cell_value(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningCellValueUpdate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.cell.edit")),
) -> dict:
    cell = await service.set_cell_value(
        sheet_id, row_id, column_id, value=payload.value, user_id=current_user.id, username=current_user.username
    )
    data = PlanningCellRead.model_validate(cell).model_dump(mode="json")
    data["display_value"] = cell.value  # only MANUAL columns reach here; locked columns are rejected earlier
    return build_success_response(data=data, request_id=request.state.request_id, message="Cell updated.")


@router.put("/sheets/{sheet_id}/rows/{row_id}/columns/{column_id}/status", summary="Set/clear a cell's CRM-style status tag")
async def set_cell_status(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningCellStatusUpdate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.cell.edit")),
) -> dict:
    """
    Attach a status tag to any cell: red (requirement), blue (ordered to
    manufacturer), green (purchased), or a custom admin-defined color.
    Send ``status_color: null`` to clear the tag.
    """
    cell = await service.set_cell_status(
        sheet_id,
        row_id,
        column_id,
        status_color=payload.status_color,
        custom_status_tag_id=payload.custom_status_tag_id,
        user_id=current_user.id,
        username=current_user.username,
    )
    data = PlanningCellRead.model_validate(cell).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Cell status updated.")


@router.put("/sheets/{sheet_id}/rows/{row_id}/columns/{column_id}/description", summary="Set/clear a cell's free-text description")
async def set_cell_description(
    sheet_id: uuid.UUID,
    row_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningCellDescriptionUpdate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.cell.edit")),
) -> dict:
    """
    Set or clear a cell's free-text description note.

    Independent of the cell's value/status; the description button only
    appears in the UI when the cell's column has enable_description set,
    but this write endpoint itself doesn't require that -- a description
    written while the setting was on is preserved if it's later turned off.
    """
    cell = await service.set_cell_description(
        sheet_id, row_id, column_id, description=payload.description, user_id=current_user.id, username=current_user.username
    )
    data = PlanningCellRead.model_validate(cell).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Cell description updated.")


# ---------------------------------------------------------------------------
# Status tags (admin-defined custom colors beyond the 3 built-ins)
# ---------------------------------------------------------------------------


@router.post("/status-tags", status_code=status.HTTP_201_CREATED, summary="Create a custom status tag/color")
async def create_status_tag(
    payload: PlanningStatusTagCreate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.sheet.manage")),
) -> dict:
    tag = await service.create_status_tag(label=payload.label, hex_color=payload.hex_color, user_id=current_user.id)
    data = PlanningStatusTagRead.model_validate(tag).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Status tag created.")


@router.get("/status-tags", summary="List custom status tags/colors")
async def list_status_tags(
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.read")),
) -> dict:
    tags = await service.list_status_tags()
    data = [PlanningStatusTagRead.model_validate(t).model_dump(mode="json") for t in tags]
    return build_success_response(data=data, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Sheet-level change history (who added/changed what, and when)
# ---------------------------------------------------------------------------


@router.get("/sheets/{sheet_id}/history", summary="Get a sheet's full change history")
async def get_sheet_history(
    sheet_id: uuid.UUID,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    _current_user: CurrentUser = Depends(require_permission("planning.read")),
) -> dict:
    entries = await service.get_sheet_history(sheet_id)
    data = [PlanningChangeLogRead.model_validate(e).model_dump(mode="json") for e in entries]
    return build_success_response(data=data, request_id=request.state.request_id)