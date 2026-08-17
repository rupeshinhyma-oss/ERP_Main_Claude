"""
Unit tests for Planning cell business rules:
- Entering 0 or clearing a Mum group column resets it to None, clears status color, and clears associated remarks.
- Remarks column rejects values if corresponding Mum group column has no active quantity (> 0).
- Cell change history feed returns both value changes and status color changes.
"""

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
import pytest

from app.core.exceptions import BadRequestException
from app.planning.models import (
    PlanningCell,
    PlanningCellStatusColor,
    PlanningChangeAction,
    PlanningChangeLog,
    PlanningColumn,
    PlanningColumnDataType,
    PlanningColumnSourceType,
    PlanningRow,
    PlanningSheet,
)
from app.planning.service import PlanningService


@pytest.mark.asyncio
async def test_set_cell_value_zero_or_blank_clears_mum_cell_status_and_remarks():
    """Writing 0 or blank into a Mum group column clears its value to None, clears status, and clears group remarks."""
    sheet_id = uuid.uuid4()
    row_id = uuid.uuid4()
    user_id = uuid.uuid4()
    col_mum1_id = uuid.uuid4()
    col_rem1_id = uuid.uuid4()

    mock_sheet = PlanningSheet(id=sheet_id, name="Mumbai", mum_group_label="Mumdarsh")
    col_mum1 = PlanningColumn(
        id=col_mum1_id, sheet_id=sheet_id, name="Mumdarsh 1", position=3,
        data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.MANUAL,
        enable_status_color=True, is_locked=False
    )
    col_rem1 = PlanningColumn(
        id=col_rem1_id, sheet_id=sheet_id, name="Mumdarsh1 Remarks", position=4,
        data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL,
        is_locked=False
    )
    mock_row = PlanningRow(id=row_id, sheet_id=sheet_id, label="Item A", position=0)

    cell_mum1 = PlanningCell(
        id=uuid.uuid4(), row_id=row_id, column_id=col_mum1_id, value="74",
        status_color=PlanningCellStatusColor.BLUE_ORDERED
    )
    cell_rem1 = PlanningCell(
        id=uuid.uuid4(), row_id=row_id, column_id=col_rem1_id, value="Urgent order"
    )

    mock_sheet_repo = AsyncMock()
    mock_sheet_repo.get_by_id.return_value = mock_sheet
    mock_col_repo = AsyncMock()
    mock_col_repo.get_by_id.side_effect = lambda cid: col_mum1 if cid == col_mum1_id else col_rem1
    mock_col_repo.list_for_sheet.return_value = [col_mum1, col_rem1]
    mock_row_repo = AsyncMock()
    mock_row_repo.get_by_id.return_value = mock_row

    mock_cell_repo = AsyncMock()

    def get_cell(r_id, c_id):
        if c_id == col_mum1_id:
            return cell_mum1
        if c_id == col_rem1_id:
            return cell_rem1
        return None

    mock_cell_repo.get_by_row_and_column.side_effect = get_cell

    async def update_cell(c, **kwargs):
        for k, v in kwargs.items():
            setattr(c, k, v)
        return c

    mock_cell_repo.update.side_effect = update_cell
    mock_cell_repo.list_for_rows.return_value = [cell_mum1, cell_rem1]

    mock_change_log_repo = AsyncMock()

    service = PlanningService(
        sheet_repository=mock_sheet_repo,
        row_repository=mock_row_repo,
        column_repository=mock_col_repo,
        cell_repository=mock_cell_repo,
        status_tag_repository=AsyncMock(),
        change_log_repository=mock_change_log_repo,
        audit_service=AsyncMock(),
        column_role_lock_repository=AsyncMock(),
    )

    # User writes "0" into Mumdarsh 1
    updated_mum_cell = await service.set_cell_value(
        sheet_id, row_id, col_mum1_id, value="0", user_id=user_id, username="admin"
    )

    # Value should be None (blank), status should be cleared (None)
    assert updated_mum_cell.value is None
    assert updated_mum_cell.status_color is None

    # The group remarks cell should also have been cleared to None
    assert cell_rem1.value is None


@pytest.mark.asyncio
async def test_remarks_rejected_if_no_active_number_in_mum_column():
    """Attempting to add remarks when the Mum column is blank or 0 raises BadRequestException."""
    sheet_id = uuid.uuid4()
    row_id = uuid.uuid4()
    user_id = uuid.uuid4()
    col_mum1_id = uuid.uuid4()
    col_rem1_id = uuid.uuid4()

    mock_sheet = PlanningSheet(id=sheet_id, name="Mumbai", mum_group_label="Mumdarsh")
    col_mum1 = PlanningColumn(
        id=col_mum1_id, sheet_id=sheet_id, name="Mumdarsh 1", position=3,
        data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.MANUAL,
        is_locked=False
    )
    col_rem1 = PlanningColumn(
        id=col_rem1_id, sheet_id=sheet_id, name="Mumdarsh1 Remarks", position=4,
        data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL,
        is_locked=False
    )
    mock_row = PlanningRow(id=row_id, sheet_id=sheet_id, label="Item B", position=0)

    # Mumdarsh 1 is empty (None)
    cell_mum1 = PlanningCell(id=uuid.uuid4(), row_id=row_id, column_id=col_mum1_id, value=None)
    cell_rem1 = PlanningCell(id=uuid.uuid4(), row_id=row_id, column_id=col_rem1_id, value=None)

    mock_sheet_repo = AsyncMock()
    mock_sheet_repo.get_by_id.return_value = mock_sheet
    mock_col_repo = AsyncMock()
    mock_col_repo.get_by_id.side_effect = lambda cid: col_rem1 if cid == col_rem1_id else col_mum1
    mock_col_repo.list_for_sheet.return_value = [col_mum1, col_rem1]
    mock_row_repo = AsyncMock()
    mock_row_repo.get_by_id.return_value = mock_row

    mock_cell_repo = AsyncMock()
    mock_cell_repo.get_by_row_and_column.side_effect = lambda r, c: cell_mum1 if c == col_mum1_id else cell_rem1

    service = PlanningService(
        sheet_repository=mock_sheet_repo,
        row_repository=mock_row_repo,
        column_repository=mock_col_repo,
        cell_repository=mock_cell_repo,
        status_tag_repository=AsyncMock(),
        change_log_repository=AsyncMock(),
        audit_service=AsyncMock(),
        column_role_lock_repository=AsyncMock(),
    )

    # Try setting remarks when Mumdarsh 1 has no quantity
    with pytest.raises(BadRequestException) as exc_info:
        await service.set_cell_value(
            sheet_id, row_id, col_rem1_id, value="New remarks", user_id=user_id, username="admin"
        )

    assert "has no active number" in str(exc_info.value)


@pytest.mark.asyncio
async def test_get_mum_column_status_history_includes_both_value_and_status_changes():
    """History feed for Approval Date includes both value edits (e.g. 50 -> 74) and status color changes."""
    sheet_id = uuid.uuid4()
    row_id = uuid.uuid4()
    col_mum1_id = uuid.uuid4()

    mock_sheet = PlanningSheet(id=sheet_id, name="Mumbai", mum_group_label="Mumdarsh")
    col_mum1 = PlanningColumn(
        id=col_mum1_id, sheet_id=sheet_id, name="Mumdarsh 1", position=3,
        data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.MANUAL,
    )
    mock_row = PlanningRow(id=row_id, sheet_id=sheet_id, label="Item C", position=0)

    now = datetime.now(timezone.utc)
    entry_val = PlanningChangeLog(
        id=uuid.uuid4(), sheet_id=sheet_id, row_id=row_id, column_id=col_mum1_id,
        action=PlanningChangeAction.CELL_VALUE_CHANGED,
        old_value="50", new_value="74",
        changed_by_username_snapshot="rupesh", created_at=now
    )
    entry_status = PlanningChangeLog(
        id=uuid.uuid4(), sheet_id=sheet_id, row_id=row_id, column_id=col_mum1_id,
        action=PlanningChangeAction.CELL_STATUS_CHANGED,
        old_value="blue_ordered", new_value="red_requirement",
        changed_by_username_snapshot="admin", created_at=now
    )

    mock_sheet_repo = AsyncMock()
    mock_sheet_repo.get_by_id.return_value = mock_sheet
    mock_col_repo = AsyncMock()
    mock_col_repo.list_for_sheet.return_value = [col_mum1]
    mock_row_repo = AsyncMock()
    mock_row_repo.get_by_id.return_value = mock_row

    mock_change_log_repo = AsyncMock()
    mock_change_log_repo.list_for_row.return_value = [entry_val, entry_status]

    service = PlanningService(
        sheet_repository=mock_sheet_repo,
        row_repository=mock_row_repo,
        column_repository=mock_col_repo,
        cell_repository=AsyncMock(),
        status_tag_repository=AsyncMock(),
        change_log_repository=mock_change_log_repo,
        audit_service=AsyncMock(),
        column_role_lock_repository=AsyncMock(),
    )

    results = await service.get_mum_column_status_history_for_row(sheet_id, row_id)

    assert len(results) == 2
    val_entry = next(r for r in results if r["entry_type"] == "value")
    assert val_entry["old_value"] == "50"
    assert val_entry["new_value"] == "74"
    assert val_entry["column_name"] == "Mumdarsh 1"

    status_entry = next(r for r in results if r["entry_type"] == "status")
    assert status_entry["old_status"] == "blue_ordered"
    assert status_entry["new_status"] == "red_requirement"
    assert status_entry["column_name"] == "Mumdarsh 1"


@pytest.mark.asyncio
async def test_clearing_mum_column_clears_approval_date_when_no_active_numbers():
    """When a Mum column is set to 0 or blank, if no Mum numbers remain on the row, the Approval Date is cleared."""
    sheet_id = uuid.uuid4()
    row_id = uuid.uuid4()
    user_id = uuid.uuid4()
    col_mum1_id = uuid.uuid4()
    col_appr_id = uuid.uuid4()

    mock_sheet = PlanningSheet(id=sheet_id, name="Mumbai", mum_group_label="Mumdarsh")
    col_mum1 = PlanningColumn(
        id=col_mum1_id, sheet_id=sheet_id, name="Mumdarsh 1", position=3,
        data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.MANUAL,
        enable_status_color=True, is_locked=False
    )
    col_appr = PlanningColumn(
        id=col_appr_id, sheet_id=sheet_id, name="Approval Date", position=2,
        data_type=PlanningColumnDataType.DATE, source_type=PlanningColumnSourceType.MANUAL,
        is_locked=False
    )
    mock_row = PlanningRow(id=row_id, sheet_id=sheet_id, label="Item D", position=0)

    cell_mum1 = PlanningCell(
        id=uuid.uuid4(), row_id=row_id, column_id=col_mum1_id, value="10",
        status_color=PlanningCellStatusColor.BLUE_ORDERED
    )
    cell_appr = PlanningCell(
        id=uuid.uuid4(), row_id=row_id, column_id=col_appr_id, value="17/08/2026"
    )

    mock_sheet_repo = AsyncMock()
    mock_sheet_repo.get_by_id.return_value = mock_sheet
    mock_col_repo = AsyncMock()
    mock_col_repo.get_by_id.side_effect = lambda cid: col_mum1 if cid == col_mum1_id else col_appr
    mock_col_repo.list_for_sheet.return_value = [col_appr, col_mum1]
    mock_row_repo = AsyncMock()
    mock_row_repo.get_by_id.return_value = mock_row

    mock_cell_repo = AsyncMock()

    def get_cell(r_id, c_id):
        if c_id == col_mum1_id:
            return cell_mum1
        if c_id == col_appr_id:
            return cell_appr
        return None

    mock_cell_repo.get_by_row_and_column.side_effect = get_cell

    async def update_cell(c, **kwargs):
        for k, v in kwargs.items():
            setattr(c, k, v)
        return c

    mock_cell_repo.update.side_effect = update_cell
    mock_cell_repo.list_for_rows.return_value = [cell_mum1, cell_appr]

    service = PlanningService(
        sheet_repository=mock_sheet_repo,
        row_repository=mock_row_repo,
        column_repository=mock_col_repo,
        cell_repository=mock_cell_repo,
        status_tag_repository=AsyncMock(),
        change_log_repository=AsyncMock(),
        audit_service=AsyncMock(),
        column_role_lock_repository=AsyncMock(),
    )

    # Set Mumdarsh 1 to 0 (cleared)
    await service.set_cell_value(
        sheet_id, row_id, col_mum1_id, value="0", user_id=user_id, username="admin"
    )

    # The Approval Date cell should be cleared to None as well
    assert cell_appr.value is None

    # Approval dates helper should also return empty dict
    appr_dates = await service.get_mum_group_approval_dates_for_row(sheet_id, row_id)
    assert appr_dates == {}

