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
  user?: Profile;
}

export interface Profile {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  employee_code?: string | null;
  username: string;
  email?: string;
  phone?: string | null;
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
  version?: number;
  status: string;
}

export interface Country extends MasterRecord {
  name: string;
  code: string;
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

export interface SupplierType extends MasterRecord {
  name: string;
  code: string;
  description?: string | null;
}

export interface CompanyBranch {
  id: string;
  name: string;
  code_prefix: string;
  address?: string | null;
  city?: string | null;
  status?: string;
}

export interface MasterCompany extends MasterRecord {
  code: string;
  name: string;
  description?: string | null;
  branches?: CompanyBranch[] | null;
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
  organization_id?: string | null;
  organization_ids?: string[] | null;
  branch_ids?: string[] | null;

  refund_vat_percent?: number | null;
  license_certificate_required?: string | null;
  conversion_factor?: number | null;
  specification?: string | null;
  description?: string | null;
  image_url?: string | null;
  images?: string[] | null;
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
  version?: number;
  username: string;
  email: string;
  phone?: string | null;
  status?: string;
  is_active?: boolean;
  roles?: string[];
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  display_name?: string | null;
  employee_name?: string | null;
  employee_code?: string | null;
  manager_id?: string | null;
  manager_name?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  date_of_joining?: string | null;
  employment_type?: string | null;
  employment_status?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postal_code?: string | null;
  emergency_contact?: string | null;
  notes?: string | null;
  last_login_at?: string | null;
  password_changed_at?: string | null;
  failed_login_count?: number | null;
  must_change_password?: boolean;
  locked_until?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by?: string | null;
  created_by_username?: string | null;
  /** Only present on the create-user response. */
  temporary_password?: string;
}

export interface UserSession {
  ip_address?: string | null;
  user_agent?: string | null;
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

export interface RoleDeletionAffectedUser {
  id: string;
  username: string;
  display_name: string;
}

export interface RoleDeletionImpact {
  role_id: string;
  role_name: string;
  is_system: boolean;
  affected_user_count: number;
  affected_users: RoleDeletionAffectedUser[];
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
  version?: number;
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
  address?: string | null;
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
  media_urls?: string | null;
  overall_remarks?: string | null;
  is_active?: boolean;
  dealing_officer_id?: string | null;
  contacts?: SupplierContact[];
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

/** A row skipped because an earlier row in the *same file* already had the same
 *  identity (as opposed to `ImportDuplicate`, which collided with a record
 *  already in the database). */
export interface InFileDuplicate {
  row: number;
  row_data?: Record<string, unknown>;
  /** Row number (within the uploaded file) of the earlier row it duplicates. */
  matchedRow?: number;
}

export interface ImportSummary {
  total_rows: number;
  created: number;
  failed: number;
  duplicate_count: number;
  errors: ImportRowError[];
  duplicates: ImportDuplicate[];
  in_file_duplicate_count?: number;
  in_file_duplicates?: InFileDuplicate[];
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