"""
Unit tests for create_next_mum_group in PlanningService.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock
import pytest

from app.planning.models import (
    PlanningColumn,
    PlanningColumnDataType,
    PlanningColumnSourceType,
    PlanningSheet,
)
from app.planning.service import PlanningService


@pytest.mark.asyncio
async def test_create_next_mum_group_creates_all_five_columns_and_normalizes():
    """Verify that create_next_mum_group detects next number, creates 5 companion columns, and orders them."""
    sheet_id = uuid.uuid4()
    user_id = uuid.uuid4()

    mock_sheet = PlanningSheet(
        id=sheet_id,
        name="Mumbai",
        mum_group_label="Mumdarsh",
    )

    # Pre-existing columns: ITEM, TEST, APPROVAL DATE, Mumdarsh 1, Mumdarsh1 Remarks, Supplier Name, City, PKG QTY, UNIT WEIGHT, CBM/PKG, NO. OF PKG MUMDARSH1, TOTAL WEIGHT MUMDARSH1, TOTAL CBM MUMDARSH1
    col_item = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="ITEM", position=0, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL)
    col_test = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="TEST(Y/N)", position=1, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL)
    col_appr = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="APPROVAL DATE", position=2, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL)
    col_m1 = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="Mumdarsh 1", position=3, data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.MANUAL, enable_status_color=True)
    col_m1_rem = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="Mumdarsh1 Remarks", position=4, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL)
    col_supp = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="Supplier Name", position=5, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.LINKED_LOOKUP, source_module="product", source_field="supplier_name")
    col_city = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="City", position=6, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.LINKED_LOOKUP, source_module="product", source_field="supplier_city")
    col_pkg_qty = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="PKG QTY", position=7, data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.LINKED_LOOKUP, source_module="product", source_field="packaging_quantity")
    col_weight = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="UNIT WEIGHT/PKG (KG)", position=8, data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.LINKED_LOOKUP, source_module="product", source_field="packaging_gross_weight")
    col_cbm = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="CBM/PKG (KG)", position=9, data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.LINKED_LOOKUP, source_module="product", source_field="packaging_unit_cbm")
    col_pkg_tot1 = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="NO. OF PKG MUMDARSH1", position=10, data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.FORMULA, is_locked=True)
    col_wt_tot1 = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="TOTAL WEIGHT MUMDARSH1", position=11, data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.FORMULA, is_locked=True)
    col_cbm_tot1 = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="TOTAL CBM MUMDARSH1", position=12, data_type=PlanningColumnDataType.NUMBER, source_type=PlanningColumnSourceType.FORMULA, is_locked=True)

    existing_cols = [
        col_item, col_test, col_appr, col_m1, col_m1_rem,
        col_supp, col_city, col_pkg_qty, col_weight, col_cbm,
        col_pkg_tot1, col_wt_tot1, col_cbm_tot1
    ]

    mock_sheet_repo = AsyncMock()
    mock_sheet_repo.get_by_id.return_value = mock_sheet

    mock_col_repo = AsyncMock()
    mock_col_repo.list_for_sheet.return_value = list(existing_cols)
    mock_session = AsyncMock()
    mock_session.add_all = MagicMock()
    mock_col_repo.session = mock_session

    service = PlanningService(
        sheet_repository=mock_sheet_repo,
        row_repository=AsyncMock(),
        column_repository=mock_col_repo,
        cell_repository=AsyncMock(),
        status_tag_repository=AsyncMock(),
        change_log_repository=AsyncMock(),
        audit_service=AsyncMock(),
        column_role_lock_repository=AsyncMock(),
    )

    result_cols = await service.create_next_mum_group(sheet_id, user_id=user_id, username="admin")

    # Verify session.add_all was called with the 5 new companion columns
    assert mock_session.add_all.called
    added_cols = mock_session.add_all.call_args[0][0]
    assert len(added_cols) == 5

    names = [c.name for c in added_cols]
    assert "Mumdarsh 2" in names
    assert "Mumdarsh2 Remarks" in names
    assert "NO. OF PKG MUMDARSH2" in names
    assert "TOTAL WEIGHT MUMDARSH2" in names
    assert "TOTAL CBM MUMDARSH2" in names

    # Main column should have enable_status_color=True
    main_col = next(c for c in added_cols if c.name == "Mumdarsh 2")
    assert main_col.enable_status_color is True
    assert main_col.data_type == PlanningColumnDataType.NUMBER

    # Formula columns should have is_locked=True and source_type=FORMULA
    pkg_col = next(c for c in added_cols if c.name == "NO. OF PKG MUMDARSH2")
    assert pkg_col.source_type == PlanningColumnSourceType.FORMULA
    assert pkg_col.is_locked is True

    # Check ordering of the result columns:
    # 1. ITEM, TEST, APPROVAL DATE
    # 2. Mumdarsh 1, Mumdarsh1 Remarks, Mumdarsh 2, Mumdarsh2 Remarks
    # 3. Supplier Name, City, PKG QTY, UNIT WEIGHT, CBM/PKG
    # 4. NO. OF PKG MUMDARSH1, TOTAL WEIGHT MUMDARSH1, TOTAL CBM MUMDARSH1, NO. OF PKG MUMDARSH2, TOTAL WEIGHT MUMDARSH2, TOTAL CBM MUMDARSH2
    result_names = [c.name for c in result_cols]
    expected_order = [
        "ITEM",
        "TEST(Y/N)",
        "APPROVAL DATE",
        "Mumdarsh 1",
        "Mumdarsh1 Remarks",
        "Mumdarsh 2",
        "Mumdarsh2 Remarks",
        "Supplier Name",
        "City",
        "PKG QTY",
        "UNIT WEIGHT/PKG (KG)",
        "CBM/PKG (KG)",
        "NO. OF PKG MUMDARSH1",
        "TOTAL WEIGHT MUMDARSH1",
        "TOTAL CBM MUMDARSH1",
        "NO. OF PKG MUMDARSH2",
        "TOTAL WEIGHT MUMDARSH2",
        "TOTAL CBM MUMDARSH2",
    ]
    assert result_names == expected_order

    # Check that positions are sequential 0..17
    for idx, c in enumerate(result_cols):
        assert c.position == idx


@pytest.mark.asyncio
async def test_create_next_mum_group_on_empty_sheet_creates_lookups_and_first_group():
    """Verify that on a sheet with no existing Mum groups or lookups, Mum 1 and the shared lookup block are created."""
    sheet_id = uuid.uuid4()
    user_id = uuid.uuid4()

    mock_sheet = PlanningSheet(
        id=sheet_id,
        name="Chennai",
        mum_group_label="Mum",
    )

    col_item = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="ITEM", position=0, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL)
    col_test = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="TEST(Y/N)", position=1, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL)
    col_appr = PlanningColumn(id=uuid.uuid4(), sheet_id=sheet_id, name="APPROVAL DATE", position=2, data_type=PlanningColumnDataType.TEXT, source_type=PlanningColumnSourceType.MANUAL)

    existing_cols = [col_item, col_test, col_appr]

    mock_sheet_repo = AsyncMock()
    mock_sheet_repo.get_by_id.return_value = mock_sheet

    mock_col_repo = AsyncMock()
    mock_col_repo.list_for_sheet.return_value = list(existing_cols)
    mock_session = AsyncMock()
    mock_session.add_all = MagicMock()
    mock_col_repo.session = mock_session

    service = PlanningService(
        sheet_repository=mock_sheet_repo,
        row_repository=AsyncMock(),
        column_repository=mock_col_repo,
        cell_repository=AsyncMock(),
        status_tag_repository=AsyncMock(),
        change_log_repository=AsyncMock(),
        audit_service=AsyncMock(),
        column_role_lock_repository=AsyncMock(),
    )

    result_cols = await service.create_next_mum_group(sheet_id, user_id=user_id, username="admin")

    # 5 shared lookups + 5 Mum 1 companion columns = 10 new columns added
    assert mock_session.add_all.called
    added_cols = mock_session.add_all.call_args[0][0]
    assert len(added_cols) == 10

    result_names = [c.name for c in result_cols]
    expected_order = [
        "ITEM",
        "TEST(Y/N)",
        "APPROVAL DATE",
        "Mum 1",
        "Mum1 Remarks",
        "Supplier Name",
        "City",
        "PKG QTY",
        "UNIT WEIGHT/PKG (KG)",
        "CBM/PKG (KG)",
        "NO. OF PKG MUM1",
        "TOTAL WEIGHT MUM1",
        "TOTAL CBM MUM1",
    ]
    assert result_names == expected_order

    for idx, c in enumerate(result_cols):
        assert c.position == idx

