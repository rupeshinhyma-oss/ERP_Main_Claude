"""
Shipment Planning API Routes.

Every write route records its own change-log + audit entry inside
:class:`app.planning.service.PlanningService`, so routes here stay thin --
they just validate permissions, call the service, and shape the response.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect, status

from app.auth.dependencies import get_auth_service
from app.auth.service import AuthService, CurrentUser
from app.core.exceptions import UnauthorizedException
from app.core.logging import get_logger
from app.core.responses import build_success_response
from app.planning import source_registry
from app.planning.dependencies import get_planning_service
from app.planning.ws_manager import connection_manager
from app.planning.schemas import (
    MumColumnStatusHistoryEntry,
    PlanningCellDescriptionUpdate,
    PlanningCellRead,
    PlanningCellStatusUpdate,
    PlanningCellValueUpdate,
    PlanningChangeLogRead,
    PlanningColumnCreate,
    PlanningColumnDescriptionUpdate,
    PlanningColumnLinkRecord,
    PlanningColumnMove,
    PlanningColumnRead,
    PlanningColumnRename,
    PlanningColumnRoleLockUpdate,
    PlanningColumnStatusColorToggle,
    PlanningColumnSourceConfigure,
    PlanningGridRead,
    PlanningItemAutoPopulate,
    PlanningItemDescriptionUpdate,
    PlanningItemLinkRecord,
    PlanningItemSourceConfigure,
    PlanningRowCreate,
    PlanningRowDescriptionUpdate,
    PlanningRowMove,
    PlanningRowRead,
    PlanningRowRename,
    PlanningSheetCreate,
    PlanningSheetDuplicate,
    PlanningSheetRead,
    PlanningSheetRename,
    PlanningStatusTagCreate,
    PlanningStatusTagRead,
    SourceModuleInfo,
)
from app.planning.service import PlanningService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/planning", tags=["Shipment Planning"])
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Live updates (WebSocket)
# ---------------------------------------------------------------------------


@router.websocket("/sheets/{sheet_id}/live")
async def sheet_live_updates(
    websocket: WebSocket,
    sheet_id: uuid.UUID,
    token: str = Query(..., description="Access token (same one used for Authorization: Bearer)."),
    auth_service: AuthService = Depends(get_auth_service),
) -> None:
    """
    Push every change made to this sheet to every other open tab, live.

    Browsers can't set an ``Authorization`` header on a WebSocket
    handshake, so the same access token normally sent as a Bearer header
    is instead passed as ``?token=...`` here -- verified through the
    exact same :meth:`AuthService.verify_access_token` path as every REST
    request, so an expired/blacklisted/revoked token is rejected exactly
    the same way.

    Once connected, this socket only *receives* events (cell edits,
    column/row changes, ...); the client keeps making its normal REST
    calls to actually perform edits. See ``app.planning.ws_manager`` for
    what triggers a broadcast and ``app.planning.service`` for the call
    sites.
    """
    try:
        current_user = await auth_service.verify_access_token(token)
    except UnauthorizedException:
        await websocket.close(code=4401, reason="Invalid or expired token.")
        return

    await connection_manager.connect(sheet_id, current_user.id, websocket)
    try:
        while True:
            # This socket is push-only from the server's perspective, but we
            # still need to await *something* on it so a client disconnect
            # (browser tab closed, network drop) raises WebSocketDisconnect
            # here instead of leaving a dead entry in the connection
            # manager forever. Any inbound message is simply ignored.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - never let a socket-level error take down the process
        logger.exception("Planning live-update socket errored.", extra={"sheet_id": str(sheet_id)})
    finally:
        connection_manager.disconnect(sheet_id, websocket)


async def _broadcast(sheet_id: uuid.UUID, event_type: str, payload: dict, *, current_user: CurrentUser) -> None:
    """
    Fan out a change to every other tab watching this sheet.

    Called after each write route's DB transaction has already committed
    (``get_db_session`` commits when the route returns normally, but this
    call happens inside the route body before the return -- the write
    itself was already flushed to the DB by the service call above it, so
    another tab reloading in response to this event will see consistent
    data). Never raises: a broadcast failure must not turn a successful
    write into a failed HTTP response for the user who made it.
    """
    try:
        await connection_manager.broadcast(
            sheet_id,
            {"type": event_type, "payload": payload, "changed_by": str(current_user.id)},
            exclude_user_id=current_user.id,
        )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to broadcast planning live-update event.", extra={"sheet_id": str(sheet_id), "event_type": event_type})


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


@router.post(
    "/sheets/{sheet_id}/duplicate",
    status_code=status.HTTP_201_CREATED,
    summary="Duplicate a sheet's exact column structure onto a new sheet, optionally renaming its group label",
)
async def duplicate_sheet(
    sheet_id: uuid.UUID,
    payload: PlanningSheetDuplicate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.sheet.manage")),
) -> dict:
    """
    Create a new sheet that starts with the exact same columns as ``sheet_id``.

    Every column (Supplier Name, City, PKG QTY, UNIT WEIGHT/PKG (KG),
    CBM/PKG (KG), every Mum group and its fixed NO. OF PKG / TOTAL
    WEIGHT / TOTAL CBM totals, ...) is recreated with the same data type,
    position, and source configuration. The one thing that's allowed to
    change is the group label -- e.g. duplicating "Mum branch" with
    ``mum_group_label="Chen"`` gives the new sheet "Chen 1" / "Chen1
    Remarks" / "NO. OF PKG CHEN1" instead of "Mum 1" / etc., while
    everything else (formulas, LINKED_LOOKUP wiring to Product Master,
    approval-date and status-color behavior) keeps working exactly the
    same on the new sheet. Rows are never copied -- the new sheet starts
    empty and is populated from Product Master the normal way.
    """
    sheet = await service.duplicate_sheet(
        sheet_id,
        name=payload.name,
        mum_group_label=payload.mum_group_label,
        description=payload.description,
        user_id=current_user.id,
        username=current_user.username,
    )
    data = PlanningSheetRead.model_validate(sheet).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Sheet duplicated.")


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
    sheet = grid["sheet"]

    # Aggregate columns yield the same value for the whole column, so compute
    # each one exactly once here rather than once per row -- avoids an
    # N-times-redundant query against the source module for a sheet with N rows.
    aggregate_cache: dict[uuid.UUID, str | None] = {}
    # LINKED_LOOKUP columns: one bulk fetch per column (not one per cell).
    # Keyed by (column_id, linked_record_id) -> resolved record, mirroring
    # the same fix applied to the ITEM column via
    # compute_row_item_displays_for_all_rows -- an admin-added
    # LINKED_LOOKUP column has the exact same N+1 query risk ITEM did.
    # Records are cached here and handed to compute_cell_display_value's
    # prefetched_record param below, so the value-extraction logic itself
    # (module.value_getter, str() conversion, etc.) still lives in exactly
    # one place rather than being duplicated here.
    linked_lookup_records: dict[tuple[uuid.UUID, uuid.UUID], Any] = {}
    for column in columns:
        if column.source_type == "aggregate":
            aggregate_cache[column.id] = await service.compute_cell_display_value(column, None)
        elif column.source_type == "linked_lookup":
            module = source_registry.get_source_module(column.source_module or "")
            if module is None:
                continue
            record_ids = {
                cell.linked_record_id
                for row in rows
                for cell in row.cells
                if cell.column_id == column.id and cell.linked_record_id is not None
            }
            if not record_ids:
                continue
            repository = module.repository_factory(service.cell_repository.session)
            records_by_id = await repository.get_by_ids(list(record_ids))
            for record_id, record in records_by_id.items():
                linked_lookup_records[(column.id, record_id)] = record

    approval_date_column_id = next(
        (c.id for c in columns if c.name.strip().lower() == "approval date"), None
    )

    # Computed ONCE for the whole sheet -- see get_mum_group_approval_dates_for_all_rows's
    # docstring for why the old per-row call here was the direct cause of
    # "Loading grid..." never finishing on a sheet with many rows.
    mum_approval_dates_by_row = await service.get_mum_group_approval_dates_for_all_rows(
        sheet_id, columns=columns, rows=rows
    )

    # ITEM's own display value, batched the same way as the LINKED_LOOKUP
    # columns above -- one query for every linked product on the sheet,
    # not one per row. See compute_row_item_displays_for_all_rows's
    # docstring for why this was the dominant cost behind the hang.
    item_display_by_row = await service.compute_row_item_displays_for_all_rows(sheet, rows)

    row_reads = []
    for row in rows:
        cells_by_column_id = {cell.column_id: cell for cell in row.cells}
        cell_reads = []
        # Every Mum group's approval date for this row, keyed by group
        # number as a string (JSON-friendly) -- looked up from the
        # sheet-wide computation above, reused below for the Approval
        # Date column's fallback display, AND sent to the frontend as
        # `mum_approval_dates` so it can recompute "the first non-hidden
        # Mum's date" itself whenever the viewer's hidden-column selection
        # changes, without another round-trip (hiding is a per-user
        # browser preference the backend has no concept of).
        mum_approval_dates = mum_approval_dates_by_row.get(row.id, {})
        # Iterate every column, not just columns with a stored cell:
        # FORMULA and AGGREGATE columns routinely have no PlanningCell row
        # at all for a given row (direct edits to them are rejected, and
        # nothing auto-creates one), but the frontend still needs one grid
        # entry per (row, column) to render the cell and its computed value.
        for column in columns:
            cell = cells_by_column_id.get(column.id)
            if column.source_type == "aggregate":
                display_value = aggregate_cache.get(column.id)
            elif column.source_type == "linked_lookup":
                # Use the sheet-wide bulk-fetched record from above (see
                # linked_lookup_records) instead of letting
                # compute_cell_display_value do its own per-cell
                # get_by_id -- the whole point of batching it above.
                prefetched = (
                    linked_lookup_records.get((column.id, cell.linked_record_id))
                    if cell is not None and cell.linked_record_id is not None
                    else None
                )
                display_value = await service.compute_cell_display_value(
                    column,
                    cell,
                    row_id=row.id,
                    prefetched_record=prefetched,
                    prefetched_sibling_columns=columns,
                    prefetched_row_cells=cells_by_column_id,
                )
            else:
                display_value = await service.compute_cell_display_value(
                    column,
                    cell,
                    row_id=row.id,
                    prefetched_sibling_columns=columns,
                    prefetched_row_cells=cells_by_column_id,
                )
            # Document: "the Approval column should show over the cell the
            # date ... when that Mum ... got the blue number". The Approval
            # Date column stays MANUAL (admins can still type over it), but
            # when nobody has typed a value for this row, auto-show the
            # earliest-numbered Mum group's approval date instead of a
            # blank cell -- computed live from the change log, never
            # persisted. This picks the globally-first Mum group
            # regardless of what any one viewer has hidden; the frontend
            # overrides it with a hidden-aware pick using
            # `mum_approval_dates` right after the grid loads.
            auto_approval_date: str | None = None
            if column.id == approval_date_column_id and not display_value and mum_approval_dates:
                auto_approval_date = mum_approval_dates[min(mum_approval_dates.keys())]
                display_value = auto_approval_date
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
            # The frontend's grid cell renders MANUAL columns from `value`,
            # not `display_value` (display_value is only read for
            # computed/FORMULA/LINKED_LOOKUP/AGGREGATE columns) -- the
            # Approval Date column is MANUAL, so the auto-computed date
            # must also be surfaced as `value`, or it silently never
            # renders even though the backend computed it correctly.
            # Real typed-in values (the `cell is not None` case above)
            # already have their own `value` from the DB and are left untouched.
            is_auto_filled = auto_approval_date is not None and cell_data.get("value") in (None, "")
            if is_auto_filled:
                cell_data["value"] = auto_approval_date
            # Explicit flag rather than making the frontend infer "was this
            # auto-filled?" by comparing strings (a manually-typed date
            # that happens to coincide with a Mum group's date would be
            # misread as auto-filled and get overwritten by the hidden-aware
            # recompute) -- unset entirely for every other column, so it
            # never leaks into unrelated cells' shape.
            if column.id == approval_date_column_id:
                cell_data["is_auto_approval_date"] = is_auto_filled
            cell_reads.append(cell_data)
        row_data = PlanningRowRead.model_validate(row).model_dump(mode="json")
        row_data["cells"] = cell_reads
        row_data["mum_approval_dates"] = {str(k): v for k, v in mum_approval_dates.items()}
        # ITEM is the sheet's built-in first column, not a row in `columns`
        # above -- when the admin has configured it as linked-lookup or
        # formula (see PlanningItemSourceConfigure), show the live computed
        # value instead of the raw stored label, same "never trust a stale
        # value" behavior as every other dynamic column. Looked up from
        # the sheet-wide batch computed above (item_display_by_row), not
        # recomputed per row here.
        row_data["label"] = item_display_by_row.get(row.id, row.label)
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
    await _broadcast(sheet_id, "column_added", data, current_user=current_user)
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
    await _broadcast(sheet_id, "column_renamed", data, current_user=current_user)
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
    await _broadcast(sheet_id, "column_moved", data, current_user=current_user)
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
    await _broadcast(sheet_id, "column_deleted", {"column_id": str(column_id)}, current_user=current_user)
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
    await _broadcast(sheet_id, "column_source_configured", data, current_user=current_user)
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
    # Batched the same way as get_grid -- one query for every linked
    # record just created, not one per row. This route creates up to
    # `limit` (often 50) rows in a single call, so the old per-row
    # compute_row_item_display here was just as much a hang risk as the
    # one in get_grid was.
    item_display_by_row = await service.compute_row_item_displays_for_all_rows(grid["sheet"], rows)
    data = []
    for row in rows:
        row_data = PlanningRowRead.model_validate(_row_to_read_dict(row)).model_dump(mode="json")
        row_data["label"] = item_display_by_row.get(row.id, row.label)
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
    await _broadcast(sheet_id, "column_role_lock_changed", data, current_user=current_user)
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
    await _broadcast(sheet_id, "column_status_color_toggled", data, current_user=current_user)
    return build_success_response(data=data, request_id=request.state.request_id, message="Column status-color setting updated.")


@router.put(
    "/sheets/{sheet_id}/columns/{column_id}/description",
    summary="Set/clear a column's single header-level free-text note",
)
async def set_column_description(
    sheet_id: uuid.UUID,
    column_id: uuid.UUID,
    payload: PlanningColumnDescriptionUpdate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    """
    Set or clear the column header's description note.

    One note per column (edited via the pencil icon on the column
    header), not per cell -- distinct from the older per-cell
    ``.../columns/{column_id}/value``-adjacent description mechanism,
    which the frontend no longer surfaces in the UI but which still
    exists for any note already written into a specific cell.
    """
    column = await service.set_column_description(
        sheet_id, column_id, description=payload.description, user_id=current_user.id, username=current_user.username
    )
    data = PlanningColumnRead.model_validate(column).model_dump(mode="json")
    await _broadcast(sheet_id, "column_description_changed", data, current_user=current_user)
    return build_success_response(data=data, request_id=request.state.request_id, message="Column description updated.")


@router.put(
    "/sheets/{sheet_id}/item-description",
    summary="Set/clear the sheet's built-in ITEM column header-level free-text note",
)
async def set_item_column_description(
    sheet_id: uuid.UUID,
    payload: PlanningItemDescriptionUpdate,
    request: Request,
    service: PlanningService = Depends(get_planning_service),
    current_user: CurrentUser = Depends(require_permission("planning.column.manage")),
) -> dict:
    sheet = await service.set_item_column_description(
        sheet_id, description=payload.description, user_id=current_user.id, username=current_user.username
    )
    data = PlanningSheetRead.model_validate(sheet).model_dump(mode="json")
    await _broadcast(sheet_id, "item_description_changed", data, current_user=current_user)
    return build_success_response(data=data, request_id=request.state.request_id, message="ITEM column description updated.")


# ---------------------------------------------------------------------------
# Rows (item lines, unlimited)
# ---------------------------------------------------------------------------


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
    await _broadcast(sheet_id, "row_renamed", data, current_user=current_user)
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
    await _broadcast(sheet_id, "row_description_changed", data, current_user=current_user)
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
    await _broadcast(sheet_id, "row_moved", data, current_user=current_user)
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
    await _broadcast(sheet_id, "row_deleted", {"row_id": str(row_id)}, current_user=current_user)
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
    # This is a real, directly-typed value (this endpoint IS the "someone
    # typed into a cell" path), never a backend auto-fill -- explicit
    # False so the frontend's hidden-column-aware Approval Date override
    # never mistakes a value the person just typed for an auto-computed one.
    data["is_auto_approval_date"] = False
    # Recompute every FORMULA column on this row (e.g. NO. OF PKG / TOTAL
    # WEIGHT / TOTAL CBM columns that reference the Mum column just typed
    # into), plus the Approval Date column's auto-computed date. Included
    # in BOTH the broadcast to other tabs AND this response: the acting
    # user's own tab is deliberately excluded from receiving its own
    # broadcast (see _broadcast's exclude_user_id), so without this in the
    # direct response, the person who actually typed the value would see
    # their own derived columns (Approval Date, formula totals) go stale
    # until their next manual reload -- everyone else gets it live via
    # the socket, but the actor themselves would not.
    derived = await service.get_row_formula_display_values(sheet_id, row_id)
    payload_out = {"cell": data, "row_id": str(row_id), "derived_values": derived}
    await _broadcast(sheet_id, "cell_value_changed", payload_out, current_user=current_user)
    return build_success_response(
        data={"cell": data, "derived_values": derived}, request_id=request.state.request_id, message="Cell updated."
    )


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
    await _broadcast(sheet_id, "cell_status_changed", {"cell": data, "row_id": str(row_id)}, current_user=current_user)
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
    await _broadcast(sheet_id, "cell_description_changed", {"cell": data, "row_id": str(row_id)}, current_user=current_user)
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