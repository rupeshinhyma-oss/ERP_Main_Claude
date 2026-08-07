/**
 * Domain types for the ERP admin API.
 *
 * Every field here is one the original plain-JS frontend actually read or
 * wrote. The backend envelope is `{ success, message, data, meta, errors }`
 * (app.core.responses); list endpoints put pagination under `meta.pagination`.
 *
 * Optional-and-nullable (`field?: T | null`) is used deliberately for columns
 * the API may omit entirely on some endpoints and return as explicit null on
 * others -- the original code guarded both cases with `x || "—"`.
 */

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

export interface PaginationMeta {
  current_page?: number;
  total_pages?: number;
  total_records?: number;
  page_size?: number;
  has_next?: boolean;
  has_previous?: boolean;
  /** Only sent by some endpoints; the effective-permissions page synthesises it. */
  total_items?: number;
}

export interface ResponseMeta {
  pagination?: PaginationMeta;
}

export interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data: T;
  meta?: ResponseMeta;
  errors?: ApiFieldError[];
}

export interface ApiFieldError {
  field?: string;
  message?: string;
  [key: string]: unknown;
}

/** What apiGet/apiPost/... resolve to. */
export interface ApiResult<T> {
  data: T;
  meta?: ResponseMeta;
}

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/* ------------------------------------------------------------------ */

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

export interface Profile {
  id?: string;
  username: string;
  email?: string;
  roles?: string[];
  permissions?: string[];
  must_change_password?: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Master data                                                        */
/* ------------------------------------------------------------------ */

/** Every master entity carries an id and an active/inactive status. */
export interface MasterRecord {
  id: string;
  status: string;
}

export interface Country extends MasterRecord {
  name: string;
  code: string;
  iso2?: string | null;
  iso3?: string | null;
  phone_code?: string | null;
  nationality?: string | null;
  currency?: string | null;
}

export interface State extends MasterRecord {
  name: string;
  code?: string | null;
  country_id: string;
}

export interface City extends MasterRecord {
  name: string;
  country_id: string;
  state_id: string;
}

export interface Currency extends MasterRecord {
  name: string;
  code: string;
  symbol?: string | null;
  decimal_places: number;
}

export interface Uom extends MasterRecord {
  code: string;
  name: string;
  short_name?: string | null;
  description?: string | null;
}

export interface Hsn extends MasterRecord {
  code: string;
  description?: string | null;
  gst_percent: number;
  refund_vat_percent?: number | null;
}

export interface Brand extends MasterRecord {
  name: string;
  code: string;
  logo_url?: string | null;
  description?: string | null;
}

export interface ProductCategory extends MasterRecord {
  code: string;
  name: string;
  description?: string | null;
}

export interface ProductSubCategory extends MasterRecord {
  code: string;
  name: string;
  category_id: string;
  description?: string | null;
}

export interface Product extends MasterRecord {
  product_code: string;
  /** Legacy single-name column; kept in sync with product_name_tally on save. */
  product_name?: string | null;
  product_name_tally?: string | null;
  product_name_invoice?: string | null;
  barcode?: string | null;
  category_id: string;
  sub_category_id?: string | null;
  brand_id?: string | null;
  hsn_id?: string | null;
  uom_id: string;
  secondary_uom_id?: string | null;
  refund_vat_percent?: number | null;
  license_certificate_required?: string | null;
  conversion_factor?: number | null;
  specification?: string | null;
  description?: string | null;
  packaging_quantity?: number | null;
  packaging_net_weight?: number | null;
  packaging_gross_weight?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  /** Older aliases the fill-form path still falls back to. */
  length?: number | null;
  width?: number | null;
  height?: number | null;
  packaging_unit_cbm?: number | null;
  color?: string | null;
  material?: string | null;
  minimum_order_quantity?: number | null;
  reorder_level?: number | null;
  standard_cost?: number | null;
  standard_price?: number | null;
  is_purchasable?: boolean;
  is_sellable?: boolean;
  image_url?: string | null;
}

/* ------------------------------------------------------------------ */
/* Organization                                                       */
/* ------------------------------------------------------------------ */

export interface Organization {
  company_name: string;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  gst_number?: string | null;
  pan_number?: string | null;
  timezone?: string | null;
  currency?: string | null;
  status?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postal_code?: string | null;
  business_hours?: string | null;
}

/** The 16 editable organization fields, in form order. */
export type OrganizationFieldId =
  | "company_name"
  | "legal_name"
  | "email"
  | "phone"
  | "website"
  | "gst_number"
  | "pan_number"
  | "timezone"
  | "currency"
  | "status"
  | "address"
  | "city"
  | "state"
  | "country"
  | "postal_code"
  | "business_hours";

/* ------------------------------------------------------------------ */
/* Users / HR                                                         */
/* ------------------------------------------------------------------ */

export interface User {
  id: string;
  username: string;
  email: string;
  status?: string;
  is_active?: boolean;
  roles?: string[];
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name?: string | null;
  employee_name?: string | null;
  employee_code?: string | null;
  phone?: string | null;
  department_id?: string | null;
  designation_id?: string | null;
  department_name?: string | null;
  designation_name?: string | null;
  last_login_at?: string | null;
  failed_login_count?: number | null;
  must_change_password?: boolean;
  /** Only present on the create-user response. */
  temporary_password?: string;
}

export interface UserSession {
  ip_address?: string | null;
  user_agent?: string | null;
}

export interface Department {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  parent_department_id?: string | null;
  manager_id?: string | null;
  status: string;
}

export interface Designation {
  id: string;
  code: string;
  title: string;
  /** Some endpoints return `name` instead of `title`. */
  name?: string;
  description?: string | null;
  level?: number | null;
  status: string;
}

export interface TeamMember {
  id: string;
  full_name: string;
  username: string;
  email: string;
  role: string;
  department_id?: string | null;
  designation_id?: string | null;
}

/* ------------------------------------------------------------------ */
/* RBAC                                                               */
/* ------------------------------------------------------------------ */

export interface Permission {
  id: string;
  code: string;
  module: string;
  description?: string | null;
}

export interface Role {
  id: string;
  name: string;
  description?: string | null;
  is_system?: boolean;
  permissions?: string[];
}

export interface UserPermissionOverride {
  id: string;
  code: string;
  is_granted: boolean;
}

export interface PermissionSource {
  code: string;
  module: string;
  source: string;
  role_names?: string[];
  override_type?: string | null;
}

export interface EffectivePermissionsBreakdown {
  /** Super admins always have every permission; overrides never apply to them. */
  is_super_admin?: boolean;
  user_info?: {
    employee_name: string;
    username: string;
    department: string;
    designation: string;
    system_roles?: string[];
    status: string;
  };
  permission_sources?: PermissionSource[];
  effective_permissions?: string[];
  role_permissions?: string[];
  user_grants?: string[];
  user_denies?: string[];
}

/** One entry in a bulk permission-override save. */
export interface BulkPermissionOverrideItem {
  permission_id: string;
  is_granted: boolean;
}

/* ------------------------------------------------------------------ */
/* Audit                                                              */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  id: string;
  created_at: string;
  username_snapshot?: string | null;
  action: string;
  module: string;
  entity_type?: string | null;
  entity_id?: string | null;
  description?: string | null;
  response_status?: number | null;
  http_method?: string | null;
  endpoint?: string | null;
  ip_address?: string | null;
  request_id?: string | null;
  old_values?: string | null;
  new_values?: string | null;
}

/* ------------------------------------------------------------------ */
/* Suppliers                                                          */
/* ------------------------------------------------------------------ */

export interface SupplierContact {
  id: string;
  salutation?: string | null;
  person_name: string;
  designation?: string | null;
  handling_territory?: string | null;
  country_id?: string | null;
  calling_number?: string | null;
  whatsapp_number?: string | null;
  wechat_number?: string | null;
  email?: string | null;
  is_primary?: boolean;
}

export interface Supplier {
  id: string;
  company_name: string;
  category_ids?: string[];
  sub_category_ids?: string[];
  product_ids?: string[];
  supplier_type?: string | null;
  brand_description?: string | null;
  country_id?: string | null;
  state_id?: string | null;
  city_id?: string | null;
  contact_salutation?: string | null;
  contact_full_name?: string | null;
  contact_designation?: string | null;
  contact_calling_number?: string | null;
  contact_whatsapp_number?: string | null;
  contact_wechat_number?: string | null;
  emails?: string[];
  tax_id_number?: string | null;
  town?: string | null;
  primary_website?: string | null;
  secondary_website?: string | null;
  supplier_grade?: string | null;
  current_status?: string | null;
  potential?: string | null;
  potential_reason?: string | null;
  secondary_products_description?: string | null;
  visited_factory_office?: boolean;
  visit_remarks?: string | null;
  visit_media?: string[] | null;
  overall_remarks?: string | null;
  is_active?: boolean;
  contacts?: SupplierContact[];
}

/* ------------------------------------------------------------------ */
/* Tasks                                                              */
/* ------------------------------------------------------------------ */

export type TaskStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "COMPLETED"
  | "CANCELLED";

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

/** PRIVATE: visible only to the creator and assignee. PUBLIC: visible to everyone. */
export type TaskVisibility = "PRIVATE" | "PUBLIC";

export interface TaskUserRef {
  id?: string;
  username: string;
  email?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  visibility?: TaskVisibility;
  assigned_to_id?: string | null;
  created_by_id?: string | null;
  assigned_to?: TaskUserRef | null;
  created_by?: TaskUserRef | null;
  due_date?: string | null;
  related_entity_type?: string | null;
  related_entity_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Backend list endpoints that wrap rows in an object rather than an array. */
export interface ItemsPage<T> {
  items: T[];
  total?: number;
}

/* ------------------------------------------------------------------ */
/* Import wizard                                                      */
/* ------------------------------------------------------------------ */

export interface ImportHeader {
  key: string;
  label: string;
  required?: boolean;
}

export interface ImportRowError {
  row: number;
  error: string;
}

export interface ImportDuplicate {
  row: number;
  row_data?: Record<string, unknown>;
  existing?: Record<string, unknown> | null;
}

export interface ImportSummary {
  total_rows: number;
  created: number;
  failed: number;
  duplicate_count: number;
  errors: ImportRowError[];
  duplicates: ImportDuplicate[];
}

/** A parsed spreadsheet row: column name -> cell value. */
export type SheetRow = Record<string, unknown>;

/** target field key -> source sheet column name (or null for "don't import"). */
export type ColumnMapping = Record<string, string | null>;

/* ------------------------------------------------------------------ */
/* Universal search                                                   */
/* ------------------------------------------------------------------ */

export interface SearchResultItem {
  category: string;
  id: string;
  title: string;
  subtitle?: string | null;
  target_url: string;
  icon: string;
  metadata?: Record<string, unknown>;
}

export interface UniversalSearchResponse {
  query: string;
  total_hits: number;
  results: SearchResultItem[];
}
