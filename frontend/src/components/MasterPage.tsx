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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppShell } from "./AppShell";
import { Banner, Can, StatusBadge, TableMessageRow } from "./ui";
import { Pagination } from "./Pagination";
import { ImportButton, ImportSummaryPanel } from "./ImportWizard";
import { SideDrawer, DetailFieldGrid, type DetailField } from "./SideDrawer";
import { downloadSampleTemplate } from "@/lib/sampleTemplate";
import { Breadcrumb } from "./Breadcrumb";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  downloadExport,
  toQueryString,
} from "@/lib/api";
import { useAuth, useSrNoJump, isSrNoQuery } from "@/lib/hooks";
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
  renderFields: (form: FormState, setField: (id: string, value: string) => void) => ReactNode;
  /** Extra query params from page-specific toolbar filters. */
  extraFilters?: Record<string, string>;
  /** Extra toolbar controls rendered after the search box. */
  toolbarExtras?: ReactNode;
  /** Inline style overrides for the modal card (Products widens it). */
  modalCardStyle?: React.CSSProperties;
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
}

export interface MasterPageHandle {
  /** Fetches the record fresh and opens the edit modal for it, same as clicking a row's Edit button. */
  openEdit: (id: string) => void;
}

export function MasterPage<T extends MasterRecord>({
  activeKey,
  apiBase,
  permissionPrefix,
  entityName,
  heading,
  subtitle,
  breadcrumbTrail,
  newButtonLabel,
  searchPlaceholder,
  columns,
  columnHeaders,
  actionsHeader,
  importHeaders,
  emptyForm,
  fillForm,
  toPayload,
  renderFields,
  extraFilters,
  toolbarExtras,
  modalCardStyle,
  resolveNames,
  reloadToken,
  detailFields,
  detailTitle,
  detailSubtitle,
  onReady,
}: MasterPageProps<T>) {
  const { hasPermission } = useAuth();

  const canCreate = hasPermission(`${permissionPrefix}.create`);
  const canUpdate = hasPermission(`${permissionPrefix}.update`);
  const canDelete = hasPermission(`${permissionPrefix}.delete`);
  const canExport = hasPermission(`${permissionPrefix}.export`);
  const canImport = hasPermission(`${permissionPrefix}.import`);

  const [rows, setRows] = useState<T[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [reloadCounter, setReloadCounter] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);

  const [drawerItem, setDrawerItem] = useState<T | null>(null);

  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const srNoJump = useSrNoJump();
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);
  // The search term actually sent to the backend. A bare Sr. No. is a
  // client-side pagination jump, so it is deliberately NOT sent as ?search=
  // (the backend's search is text-based and knows no such field).
  const [effectiveSearch, setEffectiveSearch] = useState("");

  const colCount = columns.length + 2; // +1 for Sr. No., +1 for actions
  const extraFiltersKey = JSON.stringify(extraFilters || {});

  const reload = useCallback(() => setReloadCounter((n) => n + 1), []);

  /* --- Table load --- */
  useEffect(() => {
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
    // resolveNames is intentionally omitted: pages recreate it every render,
    // and reloadToken already covers "lookups changed, reload".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    apiBase,
    currentPage,
    pageSize,
    effectiveSearch,
    statusFilter,
    extraFiltersKey,
    reloadCounter,
    reloadToken,
  ]);

  /* --- Search: 300ms debounce, with the Sr. No. jump shortcut --- */
  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = searchInput.trim();
      if (raw && isSrNoQuery(raw)) {
        const srNo = parseInt(raw, 10);
        if (srNo >= 1) {
          setCurrentPage(Math.ceil(srNo / pageSize));
          setEffectiveSearch("");
          srNoJump.request(srNo);
          return;
        }
      }
      srNoJump.clear();
      setCurrentPage(1);
      setEffectiveSearch(raw);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, pageSize]);

  // Once the target page has painted, scroll to the row and flash it.
  useEffect(() => {
    if (!loading) srNoJump.applyTo(tableBodyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rows]);

  /* --- Modal --- */
  function openModal(item: T | null) {
    setEditingId(item ? item.id : "");
    setForm(fillForm(item));
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
  }

  const setField = useCallback((id: string, value: string) => {
    setForm((prev) => ({ ...prev, [id]: value }));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let payload: unknown;
    try {
      payload = toPayload(form);
    } catch (err) {
      // Page-level validation (e.g. "Please select a valid Country.")
      setError(err);
      return;
    }
    try {
      if (editingId) {
        await apiPatch(`${apiBase}/${editingId}`, payload);
      } else {
        await apiPost(apiBase, payload);
      }
      closeModal();
      reload();
    } catch (err) {
      setError(err);
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
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleSetActive(id: string, activate: boolean) {
    try {
      await apiPost(`${apiBase}/${id}/${activate ? "activate" : "deactivate"}`);
      reload();
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

  const headerCells = useMemo(() => {
    const labels = columnHeaders ?? columns.map((col) => col.header);
    return labels.map((label, i) => <th key={`${label}-${i}`}>{label}</th>);
  }, [columns, columnHeaders]);

  // Sr. No. is a running number across the whole result set, not just this
  // page -- so page 2 continues at 21, 22, 23... rather than restarting at 1.
  const startingSrNo = (currentPage - 1) * pageSize + 1;

  return (
    <AppShell activeKey={activeKey}>
      <main className="page">
        <Breadcrumb trail={breadcrumbTrail} />
        <div className="page-header">
          <div>
            <h1>{heading}</h1>
            <div className="page-subtitle">{subtitle}</div>
          </div>
          <div className="page-header-actions">
            {canImport && (
              <button
                type="button"
                className="btn"
                title="Download a pre-formatted CSV template with example data"
                onClick={() => downloadSampleTemplate(importHeaders, entityName)}
              >
                📥 Sample Template
              </button>
            )}
            {canImport && (
              <ImportButton
                apiBase={apiBase}
                entityName={entityName}
                importHeaders={importHeaders}
                onSummary={setImportSummary}
                onError={setImportError}
                onComplete={() => reload()}
              />
            )}
            {canExport && (
              <>
                <button className="btn" onClick={() => handleExport("csv")}>
                  Export CSV
                </button>
                <button className="btn" onClick={() => handleExport("xlsx")}>
                  Export Excel
                </button>
              </>
            )}
            {canCreate && (
              <button className="btn btn-primary" onClick={() => openModal(null)}>
                {newButtonLabel}
              </button>
            )}
          </div>
        </div>
        <Banner error={error} />
        <ImportSummaryPanel summary={importSummary} error={importError} />

        <div className="card">
          <div className="toolbar">
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {toolbarExtras}
            <select
              value={statusFilter}
              onChange={(e) => {
                setCurrentPage(1);
                setStatusFilter(e.target.value);
              }}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Sr. No.</th>
                  {headerCells}
                  <th>{actionsHeader}</th>
                </tr>
              </thead>
              <tbody ref={tableBodyRef}>
                {loading ? (
                  <TableMessageRow colSpan={colCount}>Loading...</TableMessageRow>
                ) : rows.length === 0 ? (
                  <TableMessageRow colSpan={colCount}>No records found.</TableMessageRow>
                ) : (
                  rows.map((item, index) => (
                    <tr key={item.id}>
                      <td className="cell-srno">{startingSrNo + index}</td>
                      {columns.map((col, colIndex) => (
                        <td key={col.header}>
                          {colIndex === 0 && detailFields ? (
                            <a
                              href="#"
                              className="cell-primary"
                              style={{ color: "var(--color-primary)", fontWeight: 600 }}
                              onClick={(e) => {
                                e.preventDefault();
                                setDrawerItem(item);
                              }}
                            >
                              {col.render(item)}
                            </a>
                          ) : (
                            col.render(item)
                          )}
                        </td>
                      ))}
                      <td className="actions">
                        {canUpdate && (
                          <button className="btn btn-small" onClick={() => handleEdit(item.id)}>
                            Edit
                          </button>
                        )}
                        {canUpdate &&
                          (item.status === "active" ? (
                            <button
                              className="btn btn-small"
                              onClick={() => handleSetActive(item.id, false)}
                            >
                              Deactivate
                            </button>
                          ) : (
                            <button
                              className="btn btn-small"
                              onClick={() => handleSetActive(item.id, true)}
                            >
                              Activate
                            </button>
                          ))}
                        {canDelete && (
                          <button
                            className="btn btn-small btn-danger"
                            onClick={() => handleDelete(item.id)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <Pagination
              pagination={pagination}
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
            <form onSubmit={handleSubmit}>
              {renderFields(form, setField)}
              <div className="form-actions">
                <button type="submit" className="btn btn-primary">
                  Save
                </button>
                <button type="button" className="btn" onClick={closeModal}>
                  Cancel
                </button>
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
