/** Shipment Planning types. Mirrors backend/app/planning/schemas.py. */

export type PlanningColumnDataType = "text" | "number" | "date" | "boolean_yn";

export type PlanningColumnSourceType = "manual" | "linked_lookup" | "aggregate" | "formula";

export type PlanningAggregateFn = "count" | "sum" | "avg" | "min" | "max";

export type PlanningCellStatusColor =
  | "red_requirement"
  | "blue_ordered"
  | "green_purchased"
  | "custom";

export type PlanningChangeAction =
  | "SHEET_CREATED"
  | "SHEET_RENAMED"
  | "SHEET_DELETED"
  | "ROW_ADDED"
  | "ROW_RENAMED"
  | "ROW_MOVED"
  | "ROW_DELETED"
  | "COLUMN_ADDED"
  | "COLUMN_RENAMED"
  | "COLUMN_MOVED"
  | "COLUMN_DELETED"
  | "COLUMN_SOURCE_CONFIGURED"
  | "COLUMN_ROLE_LOCK_CHANGED"
  | "CELL_VALUE_CHANGED"
  | "CELL_STATUS_CHANGED";

export interface PlanningSheet {
  id: string;
  version?: number;
  name: string;
  description?: string | null;
  position: number;
  item_source_type: PlanningColumnSourceType;
  item_source_module?: string | null;
  item_source_field?: string | null;
  item_formula_expression?: string | null;
  /** When true, the ITEM column header shows a pencil button for a single note about the whole column. */
  item_enable_description?: boolean;
  /** The ITEM column's single header-level free-text note (not per-row). */
  item_description?: string | null;
  /** Persisted state of the "Load all records automatically" checkbox for the ITEM column. */
  item_auto_populate_enabled?: boolean;
  /** Persisted state of "How many records to load" for the ITEM column. null/undefined means "All". */
  item_auto_populate_limit?: number | null;
  /**
   * The word this sheet's group columns use, e.g. "Mum" in "Mum 1" /
   * "NO. OF PKG MUM1", or "Chen" in "Chen 1" / "NO. OF PKG CHEN1".
   * Defaults to "Mum" for every sheet created before this field existed.
   */
  mum_group_label?: string;
  /** The Product Master organization (MasterCompany) this sheet's branch belongs to. null only for sheets created before this link existed. */
  organization_id?: string | null;
  /** This sheet's linked branch id (one of organization_id's MasterCompany.branches entries). null only for sheets created before this link existed. */
  branch_id?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PlanningColumn {
  id: string;
  sheet_id: string;
  name: string;
  data_type: PlanningColumnDataType;
  position: number;
  is_locked: boolean;
  source_type: PlanningColumnSourceType;
  source_module?: string | null;
  source_field?: string | null;
  source_aggregate_fn?: PlanningAggregateFn | null;
  source_aggregate_filters?: Record<string, string> | null;
  formula_expression?: string | null;
  /** When true, the column header shows a pencil button for a single note about the whole column. */
  enable_description?: boolean;
  /** The column's single header-level free-text note (not per-cell/per-row). */
  description?: string | null;
  /** Persisted state of the "Load all records automatically" checkbox. */
  auto_populate_enabled?: boolean;
  /** Persisted state of "How many records to load". null/undefined means "All". */
  auto_populate_limit?: number | null;
  /** Opt-in: cells in this column can only carry a CRM-style status color when this is true. Off by default. */
  enable_status_color?: boolean;
  /** Server-persisted display width in px, shared across every user viewing the sheet. null = not manually resized yet (frontend auto-computes from the header label length). */
  width_px?: number | null;
  created_by: string;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanningCell {
  id: string | null;
  row_id: string;
  column_id: string;
  value?: string | null;
  display_value?: string | null;
  status_color?: PlanningCellStatusColor | null;
  custom_status_tag_id?: string | null;
  linked_record_id?: string | null;
  /** Legacy per-cell free-text note (no longer editable from the UI; description now lives on the column header). */
  description?: string | null;
  /**
   * True only on the Approval Date column's cell when its `value` was
   * auto-computed by the backend (nobody typed into this cell) rather
   * than a real stored value -- lets the frontend safely override it with
   * a hidden-column-aware recompute without ever touching a value
   * someone actually typed themselves. Absent/undefined on every other column.
   */
  is_auto_approval_date?: boolean;
  updated_by?: string | null;
  updated_at?: string | null;
}

export interface PlanningRow {
  id: string;
  sheet_id: string;
  label: string;
  position: number;
  linked_record_id?: string | null;
  /** Legacy per-row free-text note (no longer editable from the UI; description now lives on the ITEM column header). */
  description?: string | null;
  created_by: string;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
  cells: PlanningCell[];
  /**
   * Every Mum group's approval date for this row, keyed by group number
   * as a STRING (e.g. "2", "3" -- JSON object keys are always strings).
   * Backend-computed, hidden-column-unaware (the backend has no concept
   * of a per-user hidden column) -- the frontend picks the first
   * non-hidden group's date from this map for the Approval Date cell and
   * for the eye/history popover. See GridCell's approvalDate recomputation.
   */
  mum_approval_dates?: Record<string, string>;
}

export interface PlanningGrid {
  sheet: PlanningSheet;
  columns: PlanningColumn[];
  rows: PlanningRow[];
  /** Total live row count on the sheet (not just the rows in this page). Used for "Showing X-Y of N". */
  total_rows?: number;
  /** The offset this page was fetched with. */
  offset?: number;
  /** The page size this page was fetched with (null means "all rows"). */
  limit?: number | null;
}

export interface PlanningStatusTag {
  id: string;
  label: string;
  hex_color: string;
  created_by: string;
  created_at: string;
}

export interface PlanningChangeLogEntry {
  id: string;
  created_at: string;
  sheet_id: string;
  row_id?: string | null;
  column_id?: string | null;
  cell_id?: string | null;
  action: PlanningChangeAction;
  changed_by: string;
  changed_by_username_snapshot: string;
  old_value?: string | null;
  new_value?: string | null;
  description?: string | null;
}

/** Built-in status colors: label + swatch, keyed by backend enum value. */
export const BUILTIN_STATUS_COLORS: Record<
  Exclude<PlanningCellStatusColor, "custom">,
  { label: string; hex: string }
> = {
  red_requirement: { label: "Requirement", hex: "#DC2626" },
  blue_ordered: { label: "Ordered to Manufacturer", hex: "#2563EB" },
  green_purchased: { label: "Purchased", hex: "#16A34A" },
};

/** One field a source module (e.g. Product Master) exposes for lookup/aggregation. */
export interface SourceFieldInfo {
  key: string;
  label: string;
  is_numeric: boolean;
}

/** One module (Product/Supplier/Buyer/...) a column can pull data from. GET /planning/source-modules. */
export interface SourceModuleInfo {
  key: string;
  label: string;
  fields: SourceFieldInfo[];
}

/** One status-color change on a Mum-series column, for the Approval Date hover feed. GET /planning/sheets/{id}/rows/{id}/mum-status-history. */
export interface MumColumnStatusHistoryEntry {
  column_id: string;
  column_name: string;
  /** "status": old_status/new_status are set. "value": old_value/new_value are set. Defaults to "status" for older cached responses. */
  entry_type?: "status" | "value";
  old_status?: string | null;
  new_status?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  changed_at: string;
  changed_by_username: string;
}