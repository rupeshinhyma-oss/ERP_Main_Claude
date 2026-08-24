/**
 * Shared engine for the Master Data admin pages (countries, states, cities,
 * currencies, UOM, HSN, brands, categories, sub-categories, products).
 *
 * Each master page supplies a config and renders `<MasterPage {...config} />`,
 * which wires up table rendering, search/filter, pagination, the create/edit
 * modal, activate/deactivate, delete, and CSV/Excel import/export -- without
 * re-implementing any of it per page.
 *
 * Ported from the MasterPage IIFE in masters-common.js. Two things get simpler
 * in the React version:
 *
 *  - `fillForm(item)` returns a plain form-state object instead of poking
 *    inputs by id, and `toPayload(form)` reads that object. Validation still
 *    signals failure by throwing, and the thrown message still lands in the
 *    page banner.
 *  - Dependent dropdowns (State scoped to Country, Sub-Category scoped to
 *    Category) no longer need an imperative populate...Options() call from
 *    inside fillForm; they derive their options from the current form state, so
 *    they stay correct automatically.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppShell } from "./AppShell";
import { Banner, Can, ModalAlert, StatusBadge, TableMessageRow } from "./ui";
import { Pagination } from "./Pagination";
import {
  ImpExpDropdown,
  BulkActionsDropdown,
  ImportSummaryPanel,
  WizardModal,
  downloadSampleCsv,
  parseFile,
  type SheetRow,
} from "./ImportWizard";
import { SideDrawer, DetailFieldGrid, type DetailField } from "./SideDrawer";
import { Breadcrumb } from "./Breadcrumb";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  downloadExport,
  errorMessage,
  toQueryString,
} from "@/lib/api";
import { useAuth, useSrNoJump, useModalHistorySync } from "@/lib/hooks";
import { useLiveList } from "@/lib/live/useLiveList";
import type { ImportHeader, ImportSummary, MasterRecord, PaginationMeta } from "@/types";

/** Form state is a flat id -> string map, mirroring the original inputs. */
export type FormState = Record<string, string>;

export interface MasterColumn<T> {
  header: string;
  render: (item: T) => ReactNode;
}

export interface MasterPageProps<T extends MasterRecord> {
  /** Sidebar nav key, e.g. "masters-countries". */
  activeKey: string;
  apiBase: string;
  permissionPrefix: string;
  /** Lower-case singular used in modal titles and the delete confirm. */
  entityName: string;
  heading: string;
  subtitle: ReactNode;
  /** Breadcrumb segments after "Dashboard". */
  breadcrumbTrail: string[];
  newButtonLabel: string;
  searchPlaceholder: string;
  columns: MasterColumn<T>[];
  /**
   * Overrides the `<thead>` labels between "Sr. No." and the actions column.
   *
   * Normally the headers come from `columns[].header`. In the original app the
   * thead was hand-written HTML *separate* from the column config, so a couple
   * of pages drifted -- Products lists 11 middle headers for only 10 rendered
   * cells. Passing the labels explicitly reproduces the markup as shipped.
   */
  columnHeaders?: string[];
  /** Label for the trailing actions column; blank on most pages. */
  actionsHeader?: ReactNode;
  importHeaders: ImportHeader[];
  emptyForm: FormState;
  fillForm: (item: T | null) => FormState;
  toPayload: (form: FormState) => unknown;
  renderFields: (
    form: FormState,
    setField: (id: string, value: string) => void,
    errors?: Record<string, string>
  ) => ReactNode;
  /** Optional form-level validator that returns a map of fieldId -> errorMessage */
  validateForm?: (form: FormState) => Record<string, string>;
  /** Extra query params from page-specific toolbar filters. */
  extraFilters?: Record<string, string>;
  /** Extra toolbar controls rendered after the search box. */
  toolbarExtras?: ReactNode;
  /** Render form as a full page view preserving sidebar instead of popup overlay. */
  useFullPageForm?: boolean;
  /** Inline style overrides for the modal card (Products widens it). */
  modalCardStyle?: React.CSSProperties;
  /** Hide the "+ QUICK ADD" button in header actions. */
  hideQuickAdd?: boolean;
  /**
   * Batch-resolve related-entity names needed to render this page's columns
   * (e.g. Category/Brand/UOM names for a page of Products) -- bounded by page
   * size, not by the size of the related tables.
   */
  resolveNames?: (rows: T[]) => Promise<void>;
  /** Bump to force a reload, e.g. once lookup caches have arrived. */
  reloadToken?: unknown;
  /**
   * When supplied, the first column's cell renders as a link that opens a
   * right-side detail drawer showing this field grid, ported from the
   * generic openDetailDrawer() in masters-common.js. Nine of the ten master
   * pages use this; Products opts out (`detailFields` omitted) because it has
   * its own bespoke, multi-section drawer body instead of a flat field grid.
   */
  detailFields?: (item: T) => DetailField[];
  /** Drawer title; falls back to the entity's name/code field if omitted. */
  detailTitle?: (item: T) => ReactNode;
  /** Drawer subtitle, e.g. "Code: XYZ". */
  detailSubtitle?: (item: T) => ReactNode;
  /**
   * Called once, after mount, with a small imperative handle. Lets a page
   * with its own custom detail UI (Products' bespoke drawer, rather than the
   * generic `detailFields` grid) open the shared edit modal for a given row
   * without MasterPage needing to know anything about that custom UI.
   */
  onReady?: (handle: MasterPageHandle) => void;
  /**
   * Phase 9: module channel name (e.g. "brands", "categories", "hsn") to
   * subscribe to for real-time create/update/delete events from other
   * users. Deliberately opt-in per page rather than derived automatically
   * from `permissionPrefix` -- several pages' `permissionPrefix` values
   * (e.g. CompanyList using "company") do NOT correspond 1:1 with their
   * own live channel, so an automatic derivation would silently
   * mis-subscribe them to an unrelated module's events. Omit this prop
   * for master pages that don't yet have a registered backend
   * channel/publisher.
   */
  liveModule?: string;
  /**
   * Permission code gating the Export menu item independently from Import.
   * Optional and backward-compatible: omitted (or left undefined) pages keep
   * the original behavior where Export only shows up alongside Import
   * (i.e. gated by `${permissionPrefix}.import` like before). Pass this to
   * split Export onto its own permission, e.g. "suppliertype.export".
   */
  exportPermission?: string;
  /**
   * Permission code gating the whole Bulk Actions dropdown. Optional and
   * backward-compatible: omitted pages keep the original behavior where
   * Bulk Actions is always visible (individual bulk buttons still separately
   * require `${permissionPrefix}.update` / `.delete` as before). Pass this
   * to require a dedicated permission before the dropdown appears at all,
   * e.g. "suppliertype.bulk_action".
   */
  bulkActionPermission?: string;
  /**
   * When true, loads full catalog in-memory once and executes instant sub-millisecond
   * client-side search, multi-field filtering, and local pagination (0ms DataTables-style).
   */
  clientSideSearch?: boolean;
  /**
   * Optional custom matcher to resolve related lookup names (e.g. Brand Name, Category Name, HSN Code)
   * for instant client-side multi-field searching.
   */
  customSearchMatcher?: (item: T, term: string, cleanTerm: string) => boolean;
  /**
   * Callback fired whenever records are loaded into MasterPage.
   */
  onItemsLoaded?: (items: T[]) => void;
  /**
   * Optional custom buttons/actions rendered on the left of the header action buttons.
   */
  headerExtras?: React.ReactNode;
  /**
   * Optional custom banner or KPI panel rendered above the main table card.
   */
  bannerExtras?: React.ReactNode;
  /**
   * Optional custom inline styles applied to each row <tr>.
   */
  getRowStyle?: (item: T, index: number) => React.CSSProperties;
  /**
   * Optional custom CSS class name applied to each row <tr>.
   */
  getRowClassName?: (item: T, index: number) => string;
}

export interface MasterPageHandle {
  /** Fetches the record fresh and opens the edit modal for it, same as clicking a row's Edit button. */
  openEdit: (id: string) => void;
}

function MasterTableSkeletonRows<T extends MasterRecord>({
  count = 8,
  displayOrder,
  colCount,
  getFreezeStyle,
  columns,
}: {
  count?: number;
  displayOrder: number[];
  colCount: number;
  getFreezeStyle: (colIdx: number, isHeader?: boolean) => React.CSSProperties;
  columns: MasterColumn<T>[];
}) {
  const textWidths = ["50%", "75%", "60%", "85%", "40%", "70%", "55%", "65%"];

  return (
    <>
      {Array.from({ length: count }).map((_, rowIndex) => (
        <tr key={`master-sk-row-${rowIndex}`}>
          {displayOrder.map((colIdx) => {
            if (colIdx === 0) {
              return (
                <td
                  key={`sk-cell-0`}
                  style={{
                    width: "40px",
                    minWidth: "40px",
                    maxWidth: "45px",
                    textAlign: "center",
                    padding: "10px 8px",
                    ...getFreezeStyle(0, false),
                  }}
                >
                  <div
                    className="skeleton-line"
                    style={{ width: "16px", height: "16px", borderRadius: "4px", margin: "0 auto" }}
                  />
                </td>
              );
            }

            if (colIdx === 1) {
              return (
                <td
                  key={`sk-cell-1`}
                  style={{
                    width: "65px",
                    minWidth: "65px",
                    maxWidth: "75px",
                    textAlign: "center",
                    padding: "10px 8px",
                    ...getFreezeStyle(1, false),
                  }}
                >
                  <div
                    className="skeleton-line"
                    style={{ width: "24px", height: "14px", borderRadius: "4px", margin: "0 auto" }}
                  />
                </td>
              );
            }

            if (colIdx === colCount - 1) {
              return (
                <td
                  key={`sk-cell-action`}
                  style={{
                    textAlign: "center",
                    padding: "8px 10px",
                    ...getFreezeStyle(colCount - 1, false),
                  }}
                >
                  <div style={{ display: "flex", gap: "6px", alignItems: "center", justifyContent: "center" }}>
                    <div className="skeleton-line" style={{ width: "30px", height: "30px", borderRadius: "4px" }} />
                    <div className="skeleton-line" style={{ width: "30px", height: "30px", borderRadius: "4px" }} />
                  </div>
                </td>
              );
            }

            const mIdx = colIdx - 2;
            const col = columns[mIdx];
            const headerLower = (col?.header || "").toLowerCase();
            const isStatus = headerLower.includes("status") || headerLower.includes("active");

            return (
              <td
                key={`sk-cell-${colIdx}`}
                style={{
                  padding: "10px 14px",
                  verticalAlign: "middle",
                  ...getFreezeStyle(colIdx, false),
                }}
              >
                {isStatus ? (
                  <div
                    className="skeleton-line"
                    style={{ width: "55px", height: "20px", borderRadius: "10px" }}
                  />
                ) : (
                  <div
                    className="skeleton-line"
                    style={{
                      width: textWidths[(rowIndex + mIdx) % textWidths.length],
                      height: "15px",
                      borderRadius: "4px",
                    }}
                  />
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function computeSearchRelevance<T>(
  item: T,
  term: string,
  cleanTerm: string,
  customMatcher?: (item: T, term: string, cleanTerm: string) => boolean
): number {
  const rec = item as Record<string, unknown>;
  let maxScore = 0;

  // 1. Primary Name & Code fields (Top Priority: 100 for prefix, 80 for substring)
  const primaryKeys = [
    "product_name",
    "product_name_tally",
    "product_name_invoice",
    "name",
    "company_name",
    "title",
    "product_code",
    "code",
    "hsn_code",
  ];

  for (const key of primaryKeys) {
    const val = rec[key];
    if (val != null && (typeof val === "string" || typeof val === "number")) {
      const str = String(val).toLowerCase();
      const norm = str.replace(/[\s-]/g, "");
      if (str.startsWith(term) || norm.startsWith(cleanTerm)) {
        maxScore = Math.max(maxScore, 100);
      } else if (str.includes(term) || norm.includes(cleanTerm)) {
        maxScore = Math.max(maxScore, 80);
      }
    }
  }

  // 2. Visible Secondary Columns: Category, Sub Category, Brand, UOM, Country, City, Type (Priority: 50-60)
  const secondaryKeys = [
    "brand",
    "brand_name",
    "category",
    "category_name",
    "sub_category",
    "sub_category_name",
    "uom",
    "uom_name",
    "country",
    "city",
    "supplier_type",
    "buyer_type",
  ];

  for (const key of secondaryKeys) {
    const val = rec[key];
    if (val != null && (typeof val === "string" || typeof val === "number")) {
      const str = String(val).toLowerCase();
      const norm = str.replace(/[\s-]/g, "");
      if (str.startsWith(term) || norm.startsWith(cleanTerm)) {
        maxScore = Math.max(maxScore, 60);
      } else if (str.includes(term) || norm.includes(cleanTerm)) {
        maxScore = Math.max(maxScore, 50);
      }
    }
  }

  if (maxScore > 0) return maxScore;

  // 3. Search other fields (Deep / hidden specification or description field: Priority 10)
  for (const [key, val] of Object.entries(rec)) {
    if (val == null) continue;
    if (key === "id" || key.endsWith("_id") || key.endsWith("_ids") || key === "created_at" || key === "updated_at") {
      continue;
    }
    if (typeof val === "string" || typeof val === "number") {
      const str = String(val).toLowerCase();
      const norm = str.replace(/[\s-]/g, "");
      if (str.includes(term) || norm.includes(cleanTerm)) {
        const score = (key === "specification" || key === "description" || key === "remarks" || key === "notes") ? 10 : 30;
        maxScore = Math.max(maxScore, score);
      }
    } else if (Array.isArray(val)) {
      for (const sub of val) {
        if (sub == null) continue;
        const sStr = String(sub).toLowerCase();
        const sNorm = sStr.replace(/[\s-]/g, "");
        if (sStr.includes(term) || sNorm.includes(cleanTerm)) {
          maxScore = Math.max(maxScore, 20);
        }
      }
    }
  }

  // 4. Custom matcher fallback (e.g. resolved category/brand lookups)
  if (maxScore === 0 && customMatcher && customMatcher(item, term, cleanTerm)) {
    return 15;
  }

  return maxScore;
}

export function MasterPage<T extends MasterRecord>({
  activeKey,
  apiBase,
  permissionPrefix,
  entityName,
  heading,
  subtitle,
  breadcrumbTrail,
  newButtonLabel: _newButtonLabel,
  searchPlaceholder,
  columns,
  columnHeaders,
  actionsHeader,
  importHeaders,
  emptyForm,
  fillForm,
  toPayload,
  validateForm,
  renderFields,
  extraFilters,
  toolbarExtras,
  useFullPageForm,
  modalCardStyle,
  hideQuickAdd,
  resolveNames,
  reloadToken,
  detailFields,
  detailTitle,
  detailSubtitle,
  onReady,
  liveModule,
  exportPermission,
  bulkActionPermission,
  clientSideSearch = false,
  customSearchMatcher,
  onItemsLoaded,
  headerExtras,
  bannerExtras,
  getRowStyle,
  getRowClassName,
}: MasterPageProps<T>) {
  const { hasPermission } = useAuth();

  const canCreate = hasPermission(`${permissionPrefix}.create`);
  const canUpdate = hasPermission(`${permissionPrefix}.update`);
  const canDelete = hasPermission(`${permissionPrefix}.delete`);
  const canImport = hasPermission(`${permissionPrefix}.import`);
  // Backward-compatible: pages that don't pass exportPermission keep the
  // original behavior of Export following Import's visibility.
  const canExport = exportPermission ? hasPermission(exportPermission) : canImport;
  // Backward-compatible: pages that don't pass bulkActionPermission keep
  // Bulk Actions always visible, same as before this prop existed.
  const canBulkAction = bulkActionPermission ? hasPermission(bulkActionPermission) : true;

  const [rows, setRows] = useState<T[]>([]);
  const [allRecords, setAllRecords] = useState<T[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [filterOpen, setFilterOpen] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);
  const storageKey = `master_pinned_cols_${entityName}`;
  const [pinnedCols, setPinnedCols] = useState<Record<number, "left" | "right">>(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) {
      try {
        return JSON.parse(saved);
      } catch {
        // fallback
      }
    }
    return { 0: "left", 1: "left" };
  });

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(pinnedCols));
  }, [pinnedCols, storageKey]);

  const [colLeftOffsets, setColLeftOffsets] = useState<Record<number, number>>({});
  const [colRightOffsets, setColRightOffsets] = useState<Record<number, number>>({});
  const [pinMenuOpen, setPinMenuOpen] = useState(false);
  const pinMenuRef = useRef<HTMLDivElement>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editingItem, setEditingItem] = useState<T | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  const [drawerItem, setDrawerItem] = useState<T | null>(null);

  // Sync browser back arrow with modal & drawer: close them instead of
  // navigating back to Dashboard.
  useModalHistorySync(modalOpen, () => setModalOpen(false));
  useModalHistorySync(Boolean(drawerItem), () => setDrawerItem(null));

  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [wizardPending, setWizardPending] = useState<{
    file: File;
    rows: SheetRow[];
    sheetColumns: string[];
  } | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  useModalHistorySync(isImportOpen, () => setIsImportOpen(false));

  const handleImportSubmit = async () => {
    if (!importFile) return;
    setImportLoading(true);
    setImportError(null);
    try {
      const rows = await parseFile(importFile);
      if (!rows.length) {
        throw new Error("The file appears to be empty or has no data rows.");
      }
      setWizardPending({ file: importFile, rows, sheetColumns: Object.keys(rows[0]) });
    } catch (err) {
      setImportError(errorMessage(err) || "Could not read that file.");
    } finally {
      setImportLoading(false);
    }
  };

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [effectiveSearch, setEffectiveSearch] = useState("");
  const [alertPopup, setAlertPopup] = useState<{ title: string; message: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const colCount = columns.length + 3; // +1 for Checkbox, +1 for Sr. No., +1 for actions
  const extraFiltersKey = JSON.stringify(extraFilters || {});

  const srNoJump = useSrNoJump();
  const tableRef = useRef<HTMLTableElement>(null);
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);

  // Close popup menu when clicking outside anywhere on screen
  useEffect(() => {
    if (!pinMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pinMenuRef.current && !pinMenuRef.current.contains(e.target as Node)) {
        setPinMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pinMenuOpen]);

  const togglePin = useCallback((colIdx: number) => {
    setPinnedCols((prev) => {
      const next = { ...prev };
      if (next[colIdx]) {
        delete next[colIdx];
      } else {
        if (colIdx >= colCount - 2) {
          next[colIdx] = "right";
        } else {
          next[colIdx] = "left";
        }
      }
      return next;
    });
  }, [colCount]);

  const displayOrder = useMemo(() => {
    const allIndices = Array.from({ length: colCount }, (_, i) => i);
    const lefts = allIndices.filter((idx) => pinnedCols[idx] === "left");
    const unpinned = allIndices.filter((idx) => !pinnedCols[idx]);
    const rights = allIndices.filter((idx) => pinnedCols[idx] === "right");
    return [...lefts, ...unpinned, ...rights];
  }, [colCount, pinnedCols]);

  useLayoutEffect(() => {
    if (!tableRef.current) return;
    const tableEl = tableRef.current;

    const updateOffsets = () => {
      const ths = tableEl.querySelectorAll("thead th");
      if (!ths.length) return;

      const lefts = displayOrder.filter((idx) => pinnedCols[idx] === "left");
      let accumLeft = 0;
      const nextLefts: Record<number, number> = {};
      for (const idx of lefts) {
        const thPos = displayOrder.indexOf(idx);
        if (ths[thPos]) {
          nextLefts[idx] = accumLeft;
          accumLeft += (ths[thPos] as HTMLElement).offsetWidth;
        }
      }

      const rights = displayOrder.filter((idx) => pinnedCols[idx] === "right").reverse();
      let accumRight = 0;
      const nextRights: Record<number, number> = {};
      for (const idx of rights) {
        const thPos = displayOrder.indexOf(idx);
        if (ths[thPos]) {
          nextRights[idx] = accumRight;
          accumRight += (ths[thPos] as HTMLElement).offsetWidth;
        }
      }

      setColLeftOffsets(nextLefts);
      setColRightOffsets(nextRights);
    };

    updateOffsets();

    const ro = new ResizeObserver(() => updateOffsets());
    ro.observe(tableEl);
    return () => ro.disconnect();
  }, [pinnedCols, rows, columns, loading, displayOrder]);

  const getFreezeStyle = useCallback((colIdx: number, isHeader = false): React.CSSProperties => {
    const dir = pinnedCols[colIdx];
    if (!dir) return {};

    const lefts = displayOrder.filter((idx) => pinnedCols[idx] === "left");
    const rights = displayOrder.filter((idx) => pinnedCols[idx] === "right");

    const isLastLeft = dir === "left" && colIdx === lefts[lefts.length - 1];
    const isFirstRight = dir === "right" && colIdx === rights[0];

    if (dir === "left") {
      const left = colLeftOffsets[colIdx] ?? 0;
      return {
        position: "sticky",
        left: `${left}px`,
        zIndex: isHeader ? 12 : 10,
        backgroundColor: isHeader ? "#f8fafc" : "#ffffff",
        boxShadow: isLastLeft ? "3px 0 6px -2px rgba(0, 0, 0, 0.15)" : "none",
        borderRight: isLastLeft ? "2px solid #cbd5e1" : undefined,
      };
    }

    const right = colRightOffsets[colIdx] ?? 0;
    return {
      position: "sticky",
      right: `${right}px`,
      zIndex: isHeader ? 12 : 10,
      backgroundColor: isHeader ? "#f8fafc" : "#ffffff",
      boxShadow: isFirstRight ? "-3px 0 6px -2px rgba(0, 0, 0, 0.15)" : "none",
      borderLeft: isFirstRight ? "2px solid #cbd5e1" : undefined,
    };
  }, [pinnedCols, colLeftOffsets, colRightOffsets, displayOrder]);

  const reload = useCallback(() => setReloadCounter((n) => n + 1), []);

  /**
   * Live sync (Phase 9): every master page built on MasterPage gets
   * live sync for free when mounted. Incoming broadcasts update the
   * state in-place, keeping UI reactive.
   */
  const hasActiveMasterFilterOrSearch = Boolean(effectiveSearch) || Boolean(statusFilter) || Boolean(extraFiltersKey);
  useLiveList<T>({
    moduleName: liveModule ?? null,
    setRecords: (updater) => {
      setRows(updater);
      if (clientSideSearch) {
        setAllRecords(updater);
      }
    },
    shouldSkip: () => hasActiveMasterFilterOrSearch || currentPage !== 1,
    onApplied: (result) => {
      if (result.action === "created" || result.action === "deleted") {
        setPagination((prev) =>
          prev
            ? {
              ...prev,
              total_records:
                result.action === "created"
                  ? (prev.total_records || 0) + 1
                  : Math.max(0, (prev.total_records || 1) - 1),
            }
            : prev
        );
      }
    },
  });

  /* --- Client-Side Table Load (Executes ONCE on mount or reloadCounter) --- */
  useEffect(() => {
    if (!clientSideSearch) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const { data } = await apiGet<T[]>(`${apiBase}?page=1&page_size=10000&sort_order=asc`);
        if (cancelled) return;
        const items = data || [];
        if (resolveNames && items.length) {
          await resolveNames(items);
          if (cancelled) return;
        }
        setAllRecords(items);
        setRows(items);
        onItemsLoaded?.(items);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setAllRecords([]);
        setRows([]);
        setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clientSideSearch, apiBase, reloadCounter]);

  /* --- Server-Side Table load --- */
  useEffect(() => {
    if (clientSideSearch) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const params: Record<string, string | number> = {
        page: currentPage,
        page_size: pageSize,
        sort_order: "asc",
      };
      if (effectiveSearch) params.search = effectiveSearch;
      if (statusFilter) params.status = statusFilter;
      Object.assign(params, extraFilters || {});

      try {
        const { data, meta } = await apiGet<T[]>(apiBase + toQueryString(params));
        if (cancelled) return;
        const items = data || [];
        if (resolveNames && items.length) {
          await resolveNames(items);
          if (cancelled) return;
        }
        setRows(items);
        setPagination(meta?.pagination);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setRows([]);
        setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    clientSideSearch,
    apiBase,
    currentPage,
    pageSize,
    effectiveSearch,
    statusFilter,
    extraFiltersKey,
    reloadCounter,
    reloadToken,
  ]);

  /* --- Client-side instant 0ms search & filter with relevance ranking --- */
  const filteredRecords = useMemo(() => {
    if (!clientSideSearch) return rows;
    let list = allRecords;
    if (statusFilter) {
      list = list.filter((r) => {
        const rec = r as unknown as Record<string, unknown>;
        const st = String(rec.status ?? (rec.is_active === true ? "active" : rec.is_active === false ? "inactive" : "")).toLowerCase();
        return st === statusFilter.toLowerCase();
      });
    }
    if (extraFilters) {
      for (const [k, v] of Object.entries(extraFilters)) {
        if (v) {
          list = list.filter((r) => String((r as unknown as Record<string, unknown>)[k]) === String(v));
        }
      }
    }
    const term = searchInput.trim().toLowerCase();
    if (term) {
      const cleanTerm = term.replace(/[\s-]/g, "");
      const scored: { item: T; score: number }[] = [];
      for (const item of list) {
        const score = computeSearchRelevance(item, term, cleanTerm, customSearchMatcher);
        if (score > 0) {
          scored.push({ item, score });
        }
      }
      // Sort by relevance score descending (Name/Code matches first, then category/brand, then hidden specs last)
      scored.sort((a, b) => b.score - a.score);
      list = scored.map((x) => x.item);
    }
    return list;
  }, [clientSideSearch, rows, allRecords, statusFilter, extraFiltersKey, searchInput, customSearchMatcher]);

  const displayedRows = useMemo(() => {
    if (!clientSideSearch) return rows;
    const start = (currentPage - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [clientSideSearch, rows, filteredRecords, currentPage, pageSize]);

  const displayedPagination: PaginationMeta | undefined = useMemo(() => {
    if (!clientSideSearch) {
      return pagination;
    }
    const total = filteredRecords.length;
    const totalPages = Math.ceil(total / pageSize) || 1;
    return {
      current_page: currentPage,
      page: currentPage,
      page_size: pageSize,
      total_records: total,
      total_pages: totalPages,
      has_next: currentPage < totalPages,
      has_previous: currentPage > 1,
    };
  }, [clientSideSearch, pagination, filteredRecords.length, currentPage, pageSize]);

  /* --- Search: instant on clientSide, 300ms debounce on serverSide --- */
  useEffect(() => {
    if (clientSideSearch) {
      setCurrentPage(1);
      srNoJump.clear();
      return;
    }
    const timer = setTimeout(() => {
      const raw = searchInput.trim();
      srNoJump.clear();
      setCurrentPage(1);
      setEffectiveSearch(raw);
    }, 300);
    return () => clearTimeout(timer);
  }, [clientSideSearch, searchInput, pageSize]);

  // Once the target page has painted, scroll to the row and flash it.
  useEffect(() => {
    if (!loading) srNoJump.applyTo(tableBodyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, displayedRows]);

  /* --- Modal --- */
  function openModal(item: T | null) {
    setEditingId(item ? item.id : "");
    setEditingItem(item);
    setForm(fillForm(item));
    setError(null);
    setAlertPopup(null);
    setValidationErrors({});
    setModalOpen(true);
  }

  function closeModal() {
    setError(null);
    setAlertPopup(null);
    setValidationErrors({});
    setModalOpen(false);
  }

  const setField = useCallback((id: string, value: string) => {
    setForm((prev) => ({ ...prev, [id]: value }));
    setValidationErrors((prev) => {
      if (!prev[id]) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setAlertPopup(null);

    if (validateForm) {
      const fieldErrors = validateForm(form);
      if (fieldErrors && Object.keys(fieldErrors).length > 0) {
        setValidationErrors(fieldErrors);
        const firstMsg = Object.values(fieldErrors)[0];
        setError(firstMsg);
        const firstId = Object.keys(fieldErrors)[0];
        const el = document.getElementById(firstId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => el.focus(), 250);
        } else {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        return;
      }
    }

    const triggerAlert = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const msgLower = msg.toLowerCase();
      let targetFieldId: string | null = null;
      if (msgLower.includes("hsn")) targetFieldId = "hsn_id";
      else if (msgLower.includes("sub-category") || msgLower.includes("subcategory")) targetFieldId = "sub_category_id";
      else if (msgLower.includes("category")) targetFieldId = "category_id";
      else if (msgLower.includes("uom")) targetFieldId = "uom_id";
      else if (msgLower.includes("gross weight")) targetFieldId = "packaging_gross_weight";
      else if (msgLower.includes("quantity")) targetFieldId = "packaging_quantity";
      else if (msgLower.includes("cbm") || msgLower.includes("dimension")) targetFieldId = "packaging_unit_cbm";
      else if (msgLower.includes("tally") || msgLower.includes("product name")) targetFieldId = "product_name_tally";
      else if (msgLower.includes("product code") || msgLower.includes("code")) targetFieldId = "product_code";
      else if (msgLower.includes("brand")) targetFieldId = "brand_id";

      if (targetFieldId) {
        setValidationErrors((prev) => ({ ...prev, [targetFieldId!]: msg }));
        setError(msg);
        const el = document.getElementById(targetFieldId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => el.focus(), 250);
          return;
        }
      }

      setError(err);
      if (!useFullPageForm && (msgLower.includes("duplicate") || msgLower.includes("already exists"))) {
        setAlertPopup({ title: "Duplicate Record Warning", message: msg });
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    let payload: unknown;
    try {
      payload = toPayload(form);
    } catch (err) {
      triggerAlert(err);
      return;
    }
    setSubmitting(true);
    try {
      if (editingId) {
        // Include version if available on editingItem
        const finalPayload =
          editingItem && "version" in editingItem && typeof editingItem.version === "number"
            ? { ...((payload as object) || {}), version: editingItem.version }
            : payload;
        const { data: updatedRecord } = await apiPatch<T>(`${apiBase}/${editingId}`, finalPayload);
        const recordToUse =
          updatedRecord || ({ ...(editingItem || {}), ...((payload as object) || {}) } as T);
        if (resolveNames) {
          await resolveNames([recordToUse]);
        }
        setRows((prev) => prev.map((row) => (row.id === editingId ? recordToUse : row)));
        setAllRecords((prev) => prev.map((row) => (row.id === editingId ? recordToUse : row)));
      } else {
        const { data: newRecord } = await apiPost<T>(apiBase, payload);
        if (newRecord) {
          if (resolveNames) {
            await resolveNames([newRecord]);
          }
          setRows((prev) => [newRecord, ...prev]);
          setAllRecords((prev) => [newRecord, ...prev]);
          setPagination((prev) => (prev ? { ...prev, total_records: (prev.total_records || 0) + 1 } : prev));
        } else {
          reload();
        }
      }
      setError(null);
      setAlertPopup(null);
      setValidationErrors({});
      closeModal();
    } catch (err) {
      triggerAlert(err);
    } finally {
      setSubmitting(false);
    }
  }

  /* --- Row actions --- */
  async function handleEdit(id: string) {
    try {
      const { data } = await apiGet<T>(`${apiBase}/${id}`);
      openModal(data);
    } catch (err) {
      setError(err);
    }
  }

  useEffect(() => {
    onReady?.({ openEdit: handleEdit });
    // Intentionally runs once: onReady is a mount-time wiring callback, not a
    // reactive dependency -- re-running it on every render would just hand
    // the parent an identical handle repeatedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDelete(id: string) {
    if (!confirm(`Delete this ${entityName}? This cannot be undone.`)) return;
    try {
      await apiDelete(`${apiBase}/${id}`);
      setRows((prev) => prev.filter((row) => row.id !== id));
      setAllRecords((prev) => prev.filter((row) => row.id !== id));
      setPagination((prev) => (prev ? { ...prev, total_records: Math.max(0, (prev.total_records || 1) - 1) } : prev));
    } catch (err) {
      setError(err);
    }
  }

  async function handleExport(format: "csv" | "xlsx") {
    try {
      await downloadExport(apiBase, format, entityName);
    } catch (err) {
      setError(err);
    }
  }

  async function handleBulkActivate() {
    if (!selectedIds.length) return;
    try {
      await Promise.all(selectedIds.map((id) => apiPost(`${apiBase}/${id}/activate`)));
      setRows((prev) => prev.map((row) => (selectedIds.includes(row.id) ? { ...row, status: "active" } : row)));
      setAllRecords((prev) => prev.map((row) => (selectedIds.includes(row.id) ? { ...row, status: "active" } : row)));
      setSelectedIds([]);
    } catch (err) {
      setError(err);
    }
  }

  async function handleBulkDeactivate() {
    if (!selectedIds.length) return;
    try {
      await Promise.all(selectedIds.map((id) => apiPost(`${apiBase}/${id}/deactivate`)));
      setRows((prev) => prev.map((row) => (selectedIds.includes(row.id) ? { ...row, status: "inactive" } : row)));
      setAllRecords((prev) => prev.map((row) => (selectedIds.includes(row.id) ? { ...row, status: "inactive" } : row)));
      setSelectedIds([]);
    } catch (err) {
      setError(err);
    }
  }

  async function handleBulkDelete() {
    if (!selectedIds.length) return;
    if (!confirm(`Delete ${selectedIds.length} selected ${entityName}(s)? This cannot be undone.`)) return;
    try {
      await Promise.all(selectedIds.map((id) => apiDelete(`${apiBase}/${id}`)));
      setRows((prev) => prev.filter((row) => !selectedIds.includes(row.id)));
      setAllRecords((prev) => prev.filter((row) => !selectedIds.includes(row.id)));
      setSelectedIds([]);
    } catch (err) {
      setError(err);
    }
  }





  // Sr. No. is a running number across the whole result set, not just this
  // page -- so page 2 continues at 21, 22, 23... rather than restarting at 1.
  const startingSrNo = (currentPage - 1) * pageSize + 1;

  if (isImportOpen) {
    return (
      <AppShell activeKey={activeKey}>
        <main className="page" style={{ padding: "20px", maxWidth: "1600px", margin: "0 auto" }}>
          <Breadcrumb trail={[...breadcrumbTrail, `Import ${entityName}s`]} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <div>
              <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#0F172A", margin: 0, textTransform: "capitalize" }}>
                Import {entityName}s
              </h1>
              <div style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
                Upload bulk {entityName} records from Excel (.xlsx, .xls) or CSV.
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsImportOpen(false);
                setImportFile(null);
                setImportError(null);
              }}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#1e293b",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              ← BACK
            </button>
          </div>

          <Banner error={importError} />

          {importSummary && (
            <div style={{ marginBottom: "20px" }}>
              <ImportSummaryPanel summary={importSummary} error={importError} />
            </div>
          )}

          <div
            style={{
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
              padding: "28px 36px",
            }}
          >
            {/* Import File Section */}
            <div style={{ marginBottom: "24px" }}>
              <label style={{ display: "block", fontSize: "14px", fontWeight: 600, color: "#1e293b", marginBottom: "8px" }}>
                Import File
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid #cbd5e1",
                    borderRadius: "6px",
                    background: "#f8fafc",
                    padding: "4px 8px",
                    minWidth: "320px",
                    maxWidth: "500px",
                    flex: 1,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => importFileInputRef.current?.click()}
                    style={{
                      background: "#ffffff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "4px",
                      padding: "6px 14px",
                      fontSize: "13px",
                      fontWeight: 600,
                      color: "#334155",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Choose File
                  </button>
                  <span
                    style={{
                      paddingLeft: "12px",
                      fontSize: "13px",
                      color: importFile ? "#0f172a" : "#64748b",
                      fontWeight: importFile ? 600 : 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                    }}
                  >
                    {importFile ? importFile.name : "No file chosen"}
                  </span>
                  {importFile && (
                    <button
                      type="button"
                      onClick={() => {
                        setImportFile(null);
                        if (importFileInputRef.current) importFileInputRef.current.value = "";
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#ef4444",
                        cursor: "pointer",
                        fontSize: "14px",
                        padding: "4px 8px",
                      }}
                      title="Clear selected file"
                    >
                      ✕
                    </button>
                  )}
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setImportFile(f);
                        setImportError(null);
                      }
                    }}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => downloadSampleCsv(entityName, importHeaders)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    background: "#f8fafc",
                    border: "1px dashed #94a3b8",
                    borderRadius: "6px",
                    padding: "8px 14px",
                    color: "#475569",
                    fontSize: "13px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  📥 Download Sample CSV Template
                </button>
              </div>
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
                Only CSV, XLS, And XLSX Files Are Allowed. Maximum File Size: 8MB.
              </div>
            </div>

            {/* Notes Section */}
            <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: "20px" }}>
              <div style={{ fontSize: "14px", fontWeight: 700, color: "#1e293b", marginBottom: "12px" }}>
                Notes:
              </div>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "20px",
                  fontSize: "13px",
                  lineHeight: "1.9",
                  color: "#334155",
                }}
              >
                <li>Upload Up To <strong>5,000 Rows</strong> Per File.</li>
                <li>Avoid Special Characters (Like @ # $ % ^ & * ( ) ) In Text Fields.</li>
                <li>Maximum Allowed File Size: <strong>8 MB</strong>.</li>
                <li>Only <strong>.Csv</strong>, <strong>.Xls</strong>, And <strong>.Xlsx</strong> Files Are Accepted.</li>
                {entityName.toLowerCase() === "brand" ? (
                  <>
                    <li>Mandatory Columns: <strong>Brand Name</strong>.</li>
                    <li><strong>Brand Name</strong> must be unique.</li>
                    <li><strong>Status</strong> must be <em>Active</em> or <em>Inactive</em>.</li>
                  </>
                ) : entityName.toLowerCase() === "category" ? (
                  <>
                    <li>Mandatory Columns: <strong>Category Name</strong>.</li>
                    <li><strong>Category Name</strong> must be unique.</li>
                    <li><strong>Status</strong> must be <em>Active</em> or <em>Inactive</em>.</li>
                  </>
                ) : entityName.toLowerCase() === "sub-category" || entityName.toLowerCase() === "subcategory" ? (
                  <>
                    <li>Mandatory Columns: <strong>Category Name</strong>, <strong>Sub-Category Name</strong>.</li>
                    <li><strong>Category Name</strong> must already exist in the Category Master.</li>
                    <li><strong>Sub-Category Name</strong> must be unique within its Category.</li>
                    <li><strong>Status</strong> must be <em>Active</em> or <em>Inactive</em>.</li>
                  </>
                ) : entityName.toLowerCase().includes("product") ? (
                  <>
                    <li>Mandatory Columns: <strong>Product Name (As Per Tally)</strong>, <strong>Category</strong>, <strong>UOM</strong>, <strong>Packaging Quantity</strong>, <strong>Packaging Gross Weight (kg)</strong>, and <strong>Packaging Unit CBM</strong>.</li>
                    <li><strong>Product Name (As Per Tally)</strong> and <strong>Product Code</strong> (if provided) Must Be Unique.</li>
                    <li><strong>Category, Sub Category, Brand, HSN Code, and UOM</strong> Must Already Exist In The System.</li>
                    <li><strong>Sub Category</strong> Must Belong To The Selected <strong>Category</strong>.</li>
                    <li><strong>Packaging Unit CBM</strong> can be entered directly or automatically calculated from Length, Width, Height in cm: <code>(L × W × H) / 1,000,000</code>.</li>
                    <li><strong>Packaging Gross Weight (kg)</strong> Must Be Greater Than 0.</li>
                    <li><strong>Refund VAT %</strong> Must Be A Number Between 0 and 100.</li>
                  </>
                ) : entityName.toLowerCase().includes("hsn") ? (
                  <>
                    <li>Mandatory Columns: <strong>HSN Code</strong>.</li>
                    <li><strong>HSN Code</strong> must be unique.</li>
                    <li><strong>GST %</strong> and <strong>Refund VAT %</strong> must be valid numbers (e.g. 18, 13).</li>
                  </>
                ) : (
                  <>
                    <li>Required fields must be mapped to existing columns in the file.</li>
                    <li>Foreign-key referenced fields must already exist in their respective master tables.</li>
                  </>
                )}
                <li>No Blank Rows, Merged Cells, Or Excel Formulas Allowed.</li>
                <li>Import May Take <strong>Several Seconds</strong> Depending On File Size. Please Do Not Refresh The Page During Import.</li>
              </ul>
            </div>

            {/* Action Buttons */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "32px", borderTop: "1px solid #f1f5f9", paddingTop: "20px", gap: "12px" }}>
              <button
                type="button"
                onClick={() => {
                  setIsImportOpen(false);
                  setImportFile(null);
                  setImportError(null);
                }}
                style={{
                  padding: "9px 20px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#475569",
                  fontWeight: 600,
                  fontSize: "13.5px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!importFile || importLoading}
                onClick={handleImportSubmit}
                style={{
                  padding: "9px 28px",
                  borderRadius: "6px",
                  border: "none",
                  background: !importFile || importLoading ? "#94a3b8" : "#2563eb",
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: "13.5px",
                  cursor: !importFile || importLoading ? "not-allowed" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  boxShadow: !importFile || importLoading ? "none" : "0 2px 4px rgba(37,99,235,0.25)",
                }}
              >
                {importLoading ? "Parsing..." : "Next: Map Columns →"}
              </button>
            </div>
          </div>

          {/* Wizard Modal */}
          {wizardPending && (
            <WizardModal
              file={wizardPending.file}
              rows={wizardPending.rows}
              sheetColumns={wizardPending.sheetColumns}
              apiBase={apiBase}
              entityName={entityName}
              importHeaders={importHeaders}
              onClose={() => setWizardPending(null)}
              onComplete={(summary) => {
                setWizardPending(null);
                setImportFile(null);
                if (importFileInputRef.current) importFileInputRef.current.value = "";
                if (summary) {
                  setImportSummary(summary);
                }
                reload();
              }}
              onError={(msg) => {
                setImportError(msg);
              }}
            />
          )}
        </main>
      </AppShell>
    );
  }

  if (useFullPageForm && modalOpen) {
    return (
      <AppShell activeKey={activeKey}>
        <main className="page">
          <Breadcrumb trail={[...breadcrumbTrail, editingId ? `Edit ${entityName}` : `Add ${entityName}`]} />
          <div className="page-header" style={{ marginBottom: "20px" }}>
            <div>
              <h1 style={{ textTransform: "capitalize" }}>{editingId ? `Edit ${entityName}` : `Add ${entityName}`}</h1>
            </div>
            <div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeModal}
                style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 16px", fontWeight: 600 }}
              >
                ← BACK
              </button>
            </div>
          </div>
          <Banner error={error} />
          <div className="card" style={{ padding: "24px", marginBottom: "500px" }}>
            <form onSubmit={handleSubmit} noValidate>
              {renderFields(form, setField, validationErrors)}
              <div
                className="form-actions"
                style={{
                  display: "flex",
                  gap: "12px",
                  marginTop: "24px",
                  paddingTop: "16px",
                  borderTop: "1px solid #e2e8f0",
                }}
              >
                {hideQuickAdd ? (
                  <button type="submit" disabled={submitting} className="btn btn-add-new" style={{ padding: "10px 24px", background: "#0061f2", color: "#ffffff", fontWeight: 600, opacity: submitting ? 0.7 : 1 }}>
                    {submitting ? "Saving..." : "Save"}
                  </button>
                ) : (
                  <>
                    <button type="submit" disabled={submitting} className="btn btn-add-new" style={{ padding: "10px 24px", opacity: submitting ? 0.7 : 1 }}>
                      {submitting ? "Saving..." : "Save & Continue"}
                    </button>
                    <button
                      type="button"
                      disabled={submitting}
                      className="btn btn-quick-add"
                      style={{ padding: "10px 24px" }}
                      onClick={closeModal}
                    >
                      Save &amp; Exit
                    </button>
                  </>
                )}
              </div>
            </form>
          </div>
          <ModalAlert
            isOpen={Boolean(alertPopup)}
            title={alertPopup?.title}
            message={alertPopup?.message || ""}
            onClose={() => setAlertPopup(null)}
          />
        </main>
      </AppShell>
    );
  }

  const renderHeaderCell = (idx: number) => {

    if (idx === 0) {
      return (
        <th key="col-0" style={{ width: "40px", minWidth: "40px", maxWidth: "45px", textAlign: "center", ...getFreezeStyle(0, true) }}>
          <input
            type="checkbox"
            checked={displayedRows.length > 0 && displayedRows.every((r) => selectedIds.includes(String(r.id)))}
            onChange={(e) => {
              if (e.target.checked) {
                setSelectedIds(displayedRows.map((r) => String(r.id)));
              } else {
                setSelectedIds([]);
              }
            }}
            style={{ cursor: "pointer", width: "16px", height: "16px" }}
          />
        </th>
      );
    }

    if (idx === 1) {
      return (
        <th key="col-1" style={{ width: "65px", minWidth: "65px", maxWidth: "75px", textAlign: "center", ...getFreezeStyle(1, true) }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "2px" }}>
            <span style={{ whiteSpace: "nowrap" }}>Sr. No.</span>
            <button type="button" onClick={() => togglePin(1)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "11px", opacity: pinnedCols[1] ? 1 : 0.4, padding: "0 2px" }} title={pinnedCols[1] ? "Unfreeze" : "Freeze"}>
              📌
            </button>
          </div>
        </th>
      );
    }

    if (idx === colCount - 1) {
      return (
        <th key="col-action" style={{ textAlign: "center", ...getFreezeStyle(colCount - 1, true) }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }}>
            <span>{actionsHeader || "ACTION"}</span>
            <button type="button" onClick={() => togglePin(colCount - 1)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "11px", opacity: pinnedCols[colCount - 1] ? 1 : 0.4 }} title={pinnedCols[colCount - 1] ? "Unfreeze" : "Freeze"}>
              📌
            </button>
          </div>
        </th>
      );
    }

    const mIdx = idx - 2;
    const label = (columnHeaders ?? columns.map((col) => col.header))[mIdx];
    const isPinned = Boolean(pinnedCols[idx]);
    return (
      <th key={`col-${mIdx}-${label}`} style={getFreezeStyle(idx, true)}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
          <span>{label}</span>
          <button
            type="button"
            onClick={() => togglePin(idx)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "11px",
              opacity: isPinned ? 1 : 0.4,
              padding: "0 2px",
            }}
            title={isPinned ? "Unfreeze column" : "Freeze column"}
          >
            📌
          </button>
        </div>
      </th>
    );
  };

  const renderBodyCell = (item: T, index: number, idx: number) => {
    const rowCustomStyle = getRowStyle ? getRowStyle(item, index) : undefined;
    const freezeStyle = getFreezeStyle(idx, false);
    const cellStyle: React.CSSProperties = {
      ...freezeStyle,
      ...(rowCustomStyle?.backgroundColor
        ? { backgroundColor: rowCustomStyle.backgroundColor }
        : {}),
    };

    if (idx === 0) {
      return (
        <td key="cell-0" style={{ width: "40px", minWidth: "40px", maxWidth: "45px", textAlign: "center", ...cellStyle }}>
          <input
            type="checkbox"
            checked={selectedIds.includes(String(item.id))}
            onChange={(e) => {
              const idStr = String(item.id);
              if (e.target.checked) {
                setSelectedIds((prev) => [...prev, idStr]);
              } else {
                setSelectedIds((prev) => prev.filter((i) => i !== idStr));
              }
            }}
            style={{ cursor: "pointer", width: "16px", height: "16px" }}
          />
        </td>
      );
    }

    if (idx === 1) {
      return (
        <td key="cell-1" className="cell-srno" style={{ width: "65px", minWidth: "65px", maxWidth: "75px", textAlign: "center", ...cellStyle }}>
          {startingSrNo + index}
        </td>
      );
    }

    if (idx === colCount - 1) {
      return (
        <td key="cell-action" className="actions" style={{ textAlign: "center", ...cellStyle }}>
          <div style={{ display: "flex", gap: "6px", alignItems: "center", justifyContent: "center" }}>
            {canUpdate && (
              <button
                type="button"
                title="Edit"
                onClick={() => handleEdit(item.id)}
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "4px",
                  border: "none",
                  background: "#0061f2",
                  color: "#ffffff",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                title="Delete"
                onClick={() => handleDelete(item.id)}
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "4px",
                  border: "none",
                  background: "#ef4444",
                  color: "#ffffff",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            )}
          </div>
        </td>
      );
    }

    const mIdx = idx - 2;
    const col = columns[mIdx];
    return (
      <td key={`cell-${mIdx}-${col?.header}`} style={cellStyle}>
        {mIdx === 0 && detailFields ? (
          <a
            href="#"
            className="cell-primary"
            style={{ color: "var(--color-primary)", fontWeight: 600 }}
            onClick={(e) => {
              e.preventDefault();
              setDrawerItem(item);
            }}
          >
            {col?.render(item)}
          </a>
        ) : (
          col?.render(item)
        )}
      </td>
    );
  };

  return (
    <AppShell activeKey={activeKey}>

      <main className="page">
        <Breadcrumb trail={breadcrumbTrail} />
        <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", marginBottom: "8px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>{heading}</h1>
            <div className="page-subtitle">{subtitle}</div>
          </div>
          <div className="page-header-actions" style={{ display: "flex", gap: "10px", alignItems: "center", flexShrink: 0 }}>
            {headerExtras}
            {Boolean(toolbarExtras) && (
              <button
                type="button"
                className="btn"
                style={{
                  background: filterOpen ? "#0061f2" : "#475569",
                  color: "#ffffff",
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                }}
                onClick={() => setFilterOpen((v) => !v)}
                title="Toggle Filter Options"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                </svg>
              </button>
            )}
            {canCreate && !hideQuickAdd && (
              <button type="button" className="btn btn-quick-add" onClick={() => openModal(null)}>
                + QUICK ADD
              </button>
            )}
            {canCreate && (
              <button type="button" className="btn btn-add-new" onClick={() => openModal(null)}>
                + ADD NEW
              </button>
            )}
            {(canImport || canExport) && (
              <ImpExpDropdown
                apiBase={apiBase}
                entityName={entityName}
                importHeaders={importHeaders}
                onComplete={() => reload()}
                onSummary={setImportSummary}
                onError={(msg) => setImportError(msg)}
                onExportCsv={() => handleExport("csv")}
                showImport={canImport}
                showExport={canExport}
                onOpenImportPage={() => {
                  setImportError(null);
                  setImportSummary(null);
                  setImportFile(null);
                  setIsImportOpen(true);
                }}
              />
            )}
            {canBulkAction && (
              <BulkActionsDropdown
                selectedCount={selectedIds.length}
                onBulkActivate={canUpdate ? handleBulkActivate : undefined}
                onBulkDeactivate={canUpdate ? handleBulkDeactivate : undefined}
                onBulkDelete={canDelete ? handleBulkDelete : undefined}
              />
            )}
          </div>
        </div>
        <Banner error={error} />
        <ImportSummaryPanel summary={importSummary} error={importError} />
        {bannerExtras}

        {/* Expandable Filter Box matching Original INHYMA ERP Design (Above the main card) */}
        {Boolean(toolbarExtras) && filterOpen && (
          <div
            className="card"
            style={{
              padding: "12px 16px",
              marginBottom: "10px",
              background: "#ffffff",
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "14px",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", flex: 1 }}>
              {toolbarExtras}
            </div>
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
              <button
                type="button"
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#64748b",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setSearchInput("");
                  setCurrentPage(1);
                  reload();
                }}
              >
                Reset
              </button>
              <button
                type="button"
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#f59e0b",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setCurrentPage(1);
                  reload();
                }}
              >
                Search
              </button>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-tabs" style={{ display: "flex", gap: "20px", padding: "6px 16px 0", borderBottom: "1px solid #e2e8f0" }}>
            <button
              type="button"
              style={{
                background: "none",
                border: "none",
                borderBottom: statusFilter === "active" ? "2.5px solid #0061f2" : "2.5px solid transparent",
                color: statusFilter === "active" ? "#0061f2" : "#64748b",
                fontWeight: 700,
                fontSize: "13.5px",
                paddingBottom: "6px",
                cursor: "pointer",
              }}
              onClick={() => {
                setCurrentPage(1);
                setStatusFilter("active");
              }}
            >
              Active
            </button>
            <button
              type="button"
              style={{
                background: "none",
                border: "none",
                borderBottom: statusFilter === "inactive" ? "2.5px solid #0061f2" : "2.5px solid transparent",
                color: statusFilter === "inactive" ? "#0061f2" : "#64748b",
                fontWeight: 700,
                fontSize: "13.5px",
                paddingBottom: "6px",
                cursor: "pointer",
              }}
              onClick={() => {
                setCurrentPage(1);
                setStatusFilter("inactive");
              }}
            >
              Inactive
            </button>
          </div>

          <div className="toolbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", gap: "10px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  style={{ padding: "6px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                >
                  <option value={10}>10</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span style={{ fontSize: "13px", color: "#64748b", fontWeight: 500 }}>Items/Page</span>
              </div>

              <div ref={pinMenuRef} style={{ position: "relative" }}>
                <button
                  type="button"
                  onClick={() => setPinMenuOpen((v) => !v)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "13px",
                    background: pinMenuOpen ? "#e2e8f0" : "#ffffff",
                    cursor: "pointer",
                    color: "#0f172a",
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  📌 Freeze Columns ({Object.keys(pinnedCols).length})
                </button>
                {pinMenuOpen && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: "38px",
                      zIndex: 100,
                      background: "#ffffff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "8px",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                      padding: "12px",
                      minWidth: "220px",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <div style={{ fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "8px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      Toggle Frozen Columns
                    </div>

                    <div style={{ maxHeight: "200px", overflowY: "auto", paddingRight: "4px" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", padding: "4px 0" }}>
                        <input type="checkbox" checked={Boolean(pinnedCols[0])} onChange={() => togglePin(0)} /> Checkbox
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", padding: "4px 0" }}>
                        <input type="checkbox" checked={Boolean(pinnedCols[1])} onChange={() => togglePin(1)} /> Sr. No.
                      </label>
                      {(columnHeaders ?? columns.map((col) => col.header)).map((label, i) => {
                        const idx = i + 2;
                        const isPinned = Boolean(pinnedCols[idx]);
                        return (
                          <label key={`${label}-${i}`} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", padding: "4px 0" }}>
                            <input type="checkbox" checked={isPinned} onChange={() => togglePin(idx)} /> {label}
                          </label>
                        );
                      })}
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", padding: "4px 0", borderTop: "1px solid #f1f5f9", marginTop: "4px", paddingTop: "6px" }}>
                        <input type="checkbox" checked={Boolean(pinnedCols[colCount - 1])} onChange={() => togglePin(colCount - 1)} /> Action
                      </label>
                    </div>

                    <div style={{ borderTop: "1px solid #f1f5f9", marginTop: "8px", paddingTop: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setPinnedCols({})}
                        style={{
                          width: "100%",
                          padding: "6px 8px",
                          fontSize: "12px",
                          borderRadius: "4px",
                          border: "1px solid #e2e8f0",
                          background: "#f8fafc",
                          cursor: "pointer",
                          color: "#dc2626",
                          fontWeight: 600,
                        }}
                      >
                        Clear All Freezes
                      </button>
                    </div>
                  </div>

                )}
              </div>
            </div>

            <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
              <input
                type="text"
                placeholder={searchPlaceholder || "Search..."}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                style={{
                  padding: "8px 36px 8px 14px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  width: "280px",
                  fontSize: "13.5px",
                }}
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  title="Clear search"
                  style={{
                    position: "absolute",
                    right: "8px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#94a3b8",
                    fontSize: "16px",
                    lineHeight: 1,
                    padding: "0 2px",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="table-scroll">
            <table ref={tableRef}>

              <thead>
                <tr>
                  {displayOrder.map((idx) => renderHeaderCell(idx))}
                </tr>
              </thead>
              <tbody ref={tableBodyRef}>
                {loading ? (
                  <MasterTableSkeletonRows
                    count={8}
                    displayOrder={displayOrder}
                    colCount={colCount}
                    getFreezeStyle={getFreezeStyle}
                    columns={columns}
                  />
                ) : displayedRows.length === 0 ? (
                  <TableMessageRow colSpan={colCount}>No records found.</TableMessageRow>
                ) : (
                  displayedRows.map((item, index) => (
                    <tr
                      key={item.id}
                      className={getRowClassName ? getRowClassName(item, index) : undefined}
                      style={getRowStyle ? getRowStyle(item, index) : undefined}
                    >
                      {displayOrder.map((idx) => renderBodyCell(item, index, idx))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="pagination">

            <Pagination
              pagination={displayedPagination}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setCurrentPage(1);
              }}
            />
          </div>
        </div>
      </main>

      {modalOpen && (
        <div
          className="modal-backdrop"
          style={{ display: "flex" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="modal-card" style={modalCardStyle}>
            <div className="modal-header">
              <h2>
                {editingId ? `Edit ${entityName}` : `New ${entityName}`}
              </h2>
              <button className="modal-close" onClick={closeModal}>
                &times;
              </button>
            </div>
            <form onSubmit={handleSubmit} noValidate style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 60px)", overflow: "hidden" }}>
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
                {renderFields(form, setField, validationErrors)}
              </div>
              <div className="form-actions" style={{ display: "flex", gap: "12px", width: "100%", padding: "16px 24px", background: "#ffffff", borderTop: "1px solid #e2e8f0" }}>
                {hideQuickAdd ? (
                  <button type="submit" disabled={submitting} className="btn btn-add-new" style={{ flex: 1, justifyContent: "center", background: "#0061f2", color: "#ffffff", fontWeight: 600, opacity: submitting ? 0.7 : 1 }}>
                    {submitting ? "Saving..." : "Save"}
                  </button>
                ) : (
                  <>
                    <button type="submit" disabled={submitting} className="btn btn-add-new" style={{ flex: 1, justifyContent: "center", opacity: submitting ? 0.7 : 1 }}>
                      {submitting ? "Saving..." : "Save & Continue"}
                    </button>
                    <button type="button" disabled={submitting} className="btn btn-quick-add" style={{ flex: 1, justifyContent: "center" }} onClick={closeModal}>
                      Save &amp; Exit
                    </button>
                  </>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {detailFields && (
        <SideDrawer
          open={Boolean(drawerItem)}
          title={
            drawerItem
              ? detailTitle
                ? detailTitle(drawerItem)
                : fallbackDrawerTitle(drawerItem)
              : ""
          }
          subtitle={
            drawerItem
              ? detailSubtitle
                ? detailSubtitle(drawerItem)
                : fallbackDrawerSubtitle(drawerItem)
              : ""
          }
          onClose={() => setDrawerItem(null)}
          onEdit={
            canUpdate
              ? () => {
                const item = drawerItem;
                setDrawerItem(null);
                if (item) handleEdit(item.id);
              }
              : undefined
          }
        >
          {drawerItem && <DetailFieldGrid fields={detailFields(drawerItem)} />}
        </SideDrawer>
      )}

      <ModalAlert
        isOpen={Boolean(alertPopup)}
        title={alertPopup?.title}
        message={alertPopup?.message || ""}
        onClose={() => setAlertPopup(null)}
      />
    </AppShell>
  );
}

/** "item.name || item.code || 'Detail'" -- the drawer's default title fallback. */
function fallbackDrawerTitle(item: unknown): string {
  const record = item as Record<string, unknown>;
  const name = record.name;
  const code = record.code;
  if (typeof name === "string" && name) return name;
  if (typeof code === "string" && code) return code;
  return "Detail";
}

/** "item.code ? `Code: ${item.code}` : ''" -- the drawer's default subtitle fallback. */
function fallbackDrawerSubtitle(item: unknown): string {
  const code = (item as Record<string, unknown>).code;
  return typeof code === "string" && code ? `Code: ${code}` : "";
}

/**
 * The active/inactive <select> every master form ends with. Kept here so the
 * ten pages don't each repeat the same two options.
 */
export function StatusField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="status">Status</label>
      <select id="status" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>
    </div>
  );
}

export { StatusBadge, Can };