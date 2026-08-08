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
  name: string;
  description?: string | null;
  position: number;
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
  updated_by?: string | null;
  updated_at?: string | null;
}

export interface PlanningRow {
  id: string;
  sheet_id: string;
  label: string;
  position: number;
  created_by: string;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
  cells: PlanningCell[];
}

export interface PlanningGrid {
  sheet: PlanningSheet;
  columns: PlanningColumn[];
  rows: PlanningRow[];
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