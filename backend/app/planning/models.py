"""
Shipment Planning ORM Models.

Owns the ``planning_sheets``, ``planning_rows``, ``planning_columns``,
``planning_cells``, and ``planning_change_log`` tables.

Models the "Master Planning Sheet" spreadsheet (see the uploaded
``Master_Planning_Sheet_China_TO_India`` workbook) as a flexible grid rather
than a fixed table:

- A **sheet** is one branch tab (e.g. "Mum Branch", "MP Branch", "GJ Branch")
  -- matches the workbook's tabs 1:1.
- A **row** is one item/machine line (e.g. "ISL350XDAN Flow Wrap machine").
  Rows are freely addable/removable by any user with planning.row.manage,
  and are ordered within a sheet via ``position``.
- A **column** is admin-defined and unlimited: the built-in workbook columns
  (Tally Posted, Approval Date, Mum 34, Mum 34 Remarks, Supplier Name, ...)
  are seeded as ordinary rows in this table, not hardcoded -- so the admin's
  "add a new column, name it whatever, insert it wherever" requirement is
  the *only* code path, with no special-cased fixed columns. Columns carry
  a ``position`` so they can be inserted anywhere (e.g. between "Mum 42
  Remarks" and "Supplier Name") and a ``data_type`` that only affects how
  the frontend renders/validates the cell, never how it's stored (every
  cell value is stored as text so admin-defined columns never need a
  migration).
- A **cell** is the (row, column) value plus an optional CRM-style
  ``status_color`` tag (requirement / ordered / purchased / admin-defined
  custom colors), settable on any cell per the "admin's own creativity"
  requirement -- not restricted to a fixed set of columns.
- The **change log** is a dedicated, append-only history of every
  structural and value change (row/column added, renamed, or removed; cell
  value or status changed) -- kept separate from the general
  ``app.audit`` log so the planning grid can show inline "who/when" history
  to any user with planning.read, without requiring audit-log permissions.
  A mirrored entry is also written to the shared audit log (see
  ``app.planning.service``) for cross-module consistency.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def _enum_values(enum_cls):
    """
    Build the value list SAEnum should match DB strings against.

    Without this, SQLAlchemy's Enum type matches stored values against
    each member's *name* (e.g. "MANUAL") rather than its *value* (e.g.
    "manual") by default. Every enum in this file stores lowercase/
    snake_case values that differ from their uppercase Python names, so
    every SAEnum(...) below must pass this to avoid a LookupError the
    first time a stored value is read back.
    """
    return [member.value for member in enum_cls]


class PlanningColumnDataType(str, Enum):
    """
    How the frontend should render/validate a column's cells.

    Purely presentational -- every cell value is persisted as text
    regardless of this setting, so changing it never requires touching
    existing data.
    """

    TEXT = "text"
    NUMBER = "number"
    DATE = "date"
    BOOLEAN_YN = "boolean_yn"  # "Y" / "N", matches the workbook's "TALLY ENTRY POSTED (Y/N)"


class PlanningColumnSourceType(str, Enum):
    """
    Where a column's value comes from. Manual is the original behavior;
    the other three are the "extract data from other parts" / "add any
    calculation" feature -- admin picks per column, nothing is hardcoded.

    - MANUAL: the admin/user types the value directly into each cell (unchanged, default).
    - LINKED_LOOKUP: each row is linked to one record in another module
      (e.g. a Product); the column auto-displays one field of that record
      (e.g. its UOM, or license-required flag). Recomputed whenever the
      linked record's field changes underneath it.
    - AGGREGATE: the whole column shows one computed value pulled from
      another module (e.g. "count of active products in category X"),
      the same value repeated for every row (or shown once, per the
      frontend's choice) -- not tied to any particular row's own data.
    - FORMULA: the column's value is computed from other columns in the
      *same row* via an admin-written expression (e.g. "Mum40 * Rate"),
      evaluated with a safe, sandboxed expression parser -- never
      Python's ``eval()``.
    """

    MANUAL = "manual"
    LINKED_LOOKUP = "linked_lookup"
    AGGREGATE = "aggregate"
    FORMULA = "formula"


class PlanningCellStatusColor(str, Enum):
    """
    CRM-style status tags a user can attach to any cell.

    The three built-in colors match the requested workflow (requirement ->
    ordered -> purchased); ``CUSTOM`` lets an admin define additional
    colors/labels via ``PlanningStatusTag`` without a code change.
    """

    RED_REQUIREMENT = "red_requirement"       # Requirement raised
    BLUE_ORDERED = "blue_ordered"              # Order placed to manufacturer
    GREEN_PURCHASED = "green_purchased"        # Order purchased / received
    CUSTOM = "custom"


class PlanningChangeAction(str, Enum):
    """The closed set of structural/value actions the change log records."""

    SHEET_CREATED = "SHEET_CREATED"
    SHEET_RENAMED = "SHEET_RENAMED"
    SHEET_DELETED = "SHEET_DELETED"
    ROW_ADDED = "ROW_ADDED"
    ROW_RENAMED = "ROW_RENAMED"
    ROW_MOVED = "ROW_MOVED"
    ROW_DELETED = "ROW_DELETED"
    COLUMN_ADDED = "COLUMN_ADDED"
    COLUMN_RENAMED = "COLUMN_RENAMED"
    COLUMN_MOVED = "COLUMN_MOVED"
    COLUMN_DELETED = "COLUMN_DELETED"
    COLUMN_SOURCE_CONFIGURED = "COLUMN_SOURCE_CONFIGURED"
    COLUMN_ROLE_LOCK_CHANGED = "COLUMN_ROLE_LOCK_CHANGED"
    COLUMN_STATUS_COLOR_TOGGLED = "COLUMN_STATUS_COLOR_TOGGLED"
    CELL_VALUE_CHANGED = "CELL_VALUE_CHANGED"
    CELL_STATUS_CHANGED = "CELL_STATUS_CHANGED"
    CELL_DESCRIPTION_CHANGED = "CELL_DESCRIPTION_CHANGED"
    ROW_DESCRIPTION_CHANGED = "ROW_DESCRIPTION_CHANGED"


class PlanningSheet(UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin, Base):
    """One branch tab of the planning grid (e.g. "Mum Branch")."""

    __tablename__ = "planning_sheets"

    name: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # --- ITEM column data source (mirrors PlanningColumn's dynamic-source feature) ---
    # The first "ITEM" column of every sheet is not a row in planning_columns
    # (it doubles as the row's own label/identity), so it needs its own home
    # for the same "extract data from other parts" config admins can apply
    # to any other column. Kept on the sheet (one config for the whole
    # column) rather than per-row, exactly like PlanningColumn.source_*.
    item_source_type: Mapped[PlanningColumnSourceType] = mapped_column(
        SAEnum(PlanningColumnSourceType, name="planning_column_source_type", native_enum=False, values_callable=_enum_values),
        nullable=False,
        default=PlanningColumnSourceType.MANUAL,
    )
    item_source_module: Mapped[str | None] = mapped_column(String(100), nullable=True)
    item_source_field: Mapped[str | None] = mapped_column(String(100), nullable=True)
    item_formula_expression: Mapped[str | None] = mapped_column(Text, nullable=True)
    item_enable_description: Mapped[bool] = mapped_column(
        default=False,
        nullable=False,
        doc="When set, the ITEM column header shows a description button (pencil icon) for a "
        "single free-text note about the ITEM column as a whole -- not per-row.",
    )
    item_description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        doc="The ITEM column's single header-level free-text note, mirrors PlanningColumn.description.",
    )
    item_auto_populate_enabled: Mapped[bool] = mapped_column(
        default=False,
        nullable=False,
        doc="Persisted state of the 'Load all records automatically' checkbox for the ITEM "
        "column when it's LINKED_LOOKUP. Mirrors PlanningColumn.auto_populate_enabled.",
    )
    item_auto_populate_limit: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
        doc="Persisted state of the ITEM column's 'How many records to load' selector. NULL means 'All'.",
    )

    # --- Mum-group label (the "Mum" in "Mum 1" / "NO. OF PKG MUM1" / etc.) ---
    # Every sheet's Mum-series columns (main Mum<n> column, its Remarks
    # companion, and the three fixed-formula totals NO. OF PKG / TOTAL
    # WEIGHT / TOTAL CBM) are matched by the backend via this label, not a
    # hardcoded "Mum" string -- so a sheet duplicated from "Mum branch" as
    # "Chennai branch" can use "Chen" (or "MP", or anything else) for its
    # own groups while keeping the exact same fixed-formula/approval-date/
    # status-history behavior. See app.planning.service's
    # mum_label_pattern()/is_fixed_mum_derived_column() helpers, which read
    # this field instead of matching the literal word "Mum".
    mum_group_label: Mapped[str] = mapped_column(String(50), nullable=False, default="Mum")

    created_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)

    rows: Mapped[list["PlanningRow"]] = relationship(
        "PlanningRow", back_populates="sheet", cascade="all, delete-orphan"
    )
    columns: Mapped[list["PlanningColumn"]] = relationship(
        "PlanningColumn", back_populates="sheet", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("name", "deleted_at", name="uq_planning_sheets_name_live"),
    )


class PlanningRow(UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin, Base):
    """One item/machine line within a sheet. Freely addable/removable; unlimited."""

    __tablename__ = "planning_rows"

    sheet_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("planning_sheets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String(500), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    linked_record_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(),
        nullable=True,
        doc="Only meaningful when the sheet's item_source_type is LINKED_LOOKUP. The ID of "
        "the record in item_source_module this row's ITEM cell is linked to (e.g. a "
        "specific Product's id) -- same pattern as PlanningCell.linked_record_id.",
    )
    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        doc="Free-text note for this row's ITEM cell, independent of its label/value. Only "
        "surfaced in the UI when the sheet's enable_description is set.",
    )

    created_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)

    sheet: Mapped[PlanningSheet] = relationship("PlanningSheet", back_populates="rows")
    cells: Mapped[list["PlanningCell"]] = relationship(
        "PlanningCell", back_populates="row", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_planning_rows_sheet_position", "sheet_id", "position"),)


class PlanningColumn(UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin, Base):
    """
    An admin-defined column. Unlimited; freely nameable; insertable at any position.

    Nothing about the built-in workbook columns (Supplier Name, Mum 40,
    Mum 40 Remarks, ...) is hardcoded -- they are simply the first rows
    seeded into this table for a given sheet. An admin adds "Mum 43" (or
    anything else) exactly the same way the seed script added "Mum 40".
    """

    __tablename__ = "planning_columns"

    sheet_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("planning_sheets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    data_type: Mapped[PlanningColumnDataType] = mapped_column(
        SAEnum(PlanningColumnDataType, name="planning_column_data_type", native_enum=False, values_callable=_enum_values),
        nullable=False,
        default=PlanningColumnDataType.TEXT,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_locked: Mapped[bool] = mapped_column(
        default=False,
        nullable=False,
        doc="Locked columns (e.g. computed totals) reject direct cell edits via the API. "
        "Automatically true for linked_lookup/aggregate/formula columns -- their value is "
        "computed, not typed in.",
    )

    # --- Dynamic column feature: extract data from other modules, or compute a formula ---
    source_type: Mapped[PlanningColumnSourceType] = mapped_column(
        SAEnum(PlanningColumnSourceType, name="planning_column_source_type", native_enum=False, values_callable=_enum_values),
        nullable=False,
        default=PlanningColumnSourceType.MANUAL,
    )
    source_module: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
        doc="Registry key from app.planning.source_registry (e.g. 'product'). Required for "
        "LINKED_LOOKUP and AGGREGATE; unused for MANUAL/FORMULA.",
    )
    source_field: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
        doc="Field name on the source module to pull (e.g. 'uom_name', 'current_stock'). "
        "Required for LINKED_LOOKUP and AGGREGATE.",
    )
    source_aggregate_fn: Mapped[str | None] = mapped_column(
        String(20),
        nullable=True,
        doc="One of 'count'/'sum'/'avg'/'min'/'max', used only when source_type is AGGREGATE.",
    )
    source_aggregate_filters: Mapped[dict | None] = mapped_column(
        JSON,
        nullable=True,
        doc="Optional exact-match filters applied before aggregating, e.g. "
        "{'category_id': '...'} -- passed straight to the source module's repository.count()/list().",
    )
    formula_expression: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        doc="Admin-written expression evaluated per row via app.planning.formula (safe AST "
        "parser, never eval()). References other columns in the same row by name, e.g. "
        "'Mum40 * Rate'. Required for FORMULA columns.",
    )
    enable_description: Mapped[bool] = mapped_column(
        default=False,
        nullable=False,
        doc="When set, the column header shows a description button (pencil icon) for a "
        "single free-text note about the whole column -- not per-cell.",
    )
    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        doc="The column's single header-level free-text note, shown/edited via the pencil "
        "button on the column header when enable_description is set. One note per column, "
        "not per cell/row.",
    )
    auto_populate_enabled: Mapped[bool] = mapped_column(
        default=False,
        nullable=False,
        doc="Persisted state of the 'Load all records automatically' checkbox for a "
        "LINKED_LOOKUP column. Purely a remembered UI preference -- re-running the actual "
        "bulk-link job is still a separate explicit action (see PlanningService.auto_link_column_to_item_records), "
        "this field only makes the checkbox itself survive closing and reopening the config modal.",
    )
    auto_populate_limit: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
        doc="Persisted state of the 'How many records to load' selector (25/50/100), paired with "
        "auto_populate_enabled. NULL means 'All'.",
    )
    enable_status_color: Mapped[bool] = mapped_column(
        default=False,
        nullable=False,
        doc="Opt-in per column: when False (the default for every column, including existing "
        "ones as of this field's introduction), cells in this column cannot carry a CRM-style "
        "status color and the status-dot button is hidden entirely -- set True to allow it.",
    )

    created_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)

    sheet: Mapped[PlanningSheet] = relationship("PlanningSheet", back_populates="columns")
    cells: Mapped[list["PlanningCell"]] = relationship(
        "PlanningCell", back_populates="column", cascade="all, delete-orphan"
    )
    role_locks: Mapped[list["PlanningColumnRoleLock"]] = relationship(
        "PlanningColumnRoleLock", back_populates="column", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_planning_columns_sheet_position", "sheet_id", "position"),)


class PlanningCell(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The (row, column) value + optional CRM-style status color."""

    __tablename__ = "planning_cells"

    row_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("planning_rows.id", ondelete="CASCADE"), nullable=False, index=True
    )
    column_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("planning_columns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_color: Mapped[PlanningCellStatusColor | None] = mapped_column(
        SAEnum(PlanningCellStatusColor, name="planning_cell_status_color", native_enum=False, values_callable=_enum_values), nullable=True
    )
    custom_status_tag_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("planning_status_tags.id"), nullable=True,
        doc="Set when status_color == CUSTOM; points at the admin-defined tag/color.",
    )
    linked_record_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(),
        nullable=True,
        doc="Only meaningful when the cell's column has source_type=LINKED_LOOKUP. The ID of "
        "the record in that column's source_module this row is linked to (e.g. a specific "
        "Product's id). Not a DB foreign key -- the target table varies by source_module, "
        "so referential integrity is enforced in app.planning.service, not at the schema level.",
    )
    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        doc="Free-text note for this cell, independent of its value/status. Only surfaced in "
        "the UI when the cell's column has enable_description set.",
    )

    updated_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)

    row: Mapped[PlanningRow] = relationship("PlanningRow", back_populates="cells")
    column: Mapped[PlanningColumn] = relationship("PlanningColumn", back_populates="cells")

    __table_args__ = (
        UniqueConstraint("row_id", "column_id", name="uq_planning_cells_row_column"),
        Index("ix_planning_cells_row_column", "row_id", "column_id"),
    )


class PlanningStatusTag(UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin, Base):
    """
    An admin-defined custom status color/label beyond the 3 built-ins.

    Lets an admin add e.g. "Delayed" (orange) or "Cancelled" (grey) without
    a code change; ``PlanningCell.status_color`` is set to CUSTOM and
    ``custom_status_tag_id`` points here.
    """

    __tablename__ = "planning_status_tags"

    label: Mapped[str] = mapped_column(String(100), nullable=False)
    hex_color: Mapped[str] = mapped_column(String(7), nullable=False, doc="e.g. '#F97316'")
    created_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)

    __table_args__ = (UniqueConstraint("label", "deleted_at", name="uq_planning_status_tags_label_live"),)


class PlanningChangeLog(UUIDPrimaryKeyMixin, Base):
    """
    Dedicated, append-only history for the planning grid.

    Deliberately separate from ``app.audit.models.AuditLog`` (which also
    receives a mirrored entry -- see ``app.planning.service``) so the grid
    UI can show "who added this row / when was this cell last changed"
    inline to any planning.read user, without requiring audit-log
    permissions, and without paying the cost of filtering the shared audit
    log by module + entity for every grid render.
    """

    __tablename__ = "planning_change_log"

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False, index=True
    )

    sheet_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("planning_sheets.id"), nullable=False, index=True)
    row_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True, index=True)
    column_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True, index=True)
    cell_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True, index=True)

    action: Mapped[PlanningChangeAction] = mapped_column(
        SAEnum(PlanningChangeAction, name="planning_change_action", native_enum=False, values_callable=_enum_values), nullable=False
    )

    changed_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    changed_by_username_snapshot: Mapped[str] = mapped_column(String(100), nullable=False)

    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(
        Text, nullable=True, doc="Human-readable summary, e.g. \"Added column 'Mum 43'\"."
    )

    __table_args__ = (
        Index("ix_planning_change_log_sheet_created", "sheet_id", "created_at"),
        Index("ix_planning_change_log_row", "row_id"),
        Index("ix_planning_change_log_column", "column_id"),
    )


class PlanningColumnRoleLock(UUIDPrimaryKeyMixin, Base):
    """
    Restricts editing of one column's config/formula/cells to specific roles.

    Optional and additive: a column with no rows here is governed only by
    the sheet-level ``planning.column.manage`` / ``planning.cell.edit``
    permissions, unchanged from before this feature. A column WITH rows
    here can only be edited by a user holding at least one of the listed
    roles (super_admin always bypasses, per the system-wide convention) --
    letting an admin say "only the Purchase team can touch this column's
    formula" without touching the sheet's overall permissions.
    """

    __tablename__ = "planning_column_role_locks"
    __table_args__ = (UniqueConstraint("column_id", "role_id", name="uq_planning_column_role_lock"),)

    column_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("planning_columns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("roles.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    column: Mapped[PlanningColumn] = relationship("PlanningColumn", back_populates="role_locks")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<PlanningColumnRoleLock column_id={self.column_id} role_id={self.role_id}>"