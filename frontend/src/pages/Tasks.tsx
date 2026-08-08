/**
 * Tasks & Work Management. Ported from tasks.html + tasks.js.
 *
 * The whole task list is fetched once (limit=100) and then filtered, counted
 * and grouped client-side, so switching between List and Kanban or flipping a
 * preset pill is instant and costs no extra requests.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can } from "@/components/ui";
import { IconKanbanView, IconListView, IconPlus } from "@/components/icons";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "@/lib/api";
import { initials } from "@/lib/auth";
import { useAuth } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import type { ItemsPage, Task, TaskPriority, TaskStatus, TaskVisibility } from "@/types";

type ViewMode = "list" | "kanban";
type Preset = "all" | "my_assigned" | "my_created" | "urgent";

const STAGES: TaskStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "IN_REVIEW",
  "COMPLETED",
  "CANCELLED",
];

const STAGE_LABELS: Record<TaskStatus, string> = {
  PENDING: "📋 Pending",
  IN_PROGRESS: "⚡ In Progress",
  IN_REVIEW: "🔍 In Review",
  COMPLETED: "✅ Completed",
  CANCELLED: "🚫 Cancelled",
};

const STATUS_BADGES: Record<TaskStatus, string> = {
  PENDING: "⏳ Pending",
  IN_PROGRESS: "⚡ In Progress",
  IN_REVIEW: "🔍 In Review",
  COMPLETED: "✅ Completed",
  CANCELLED: "🚫 Cancelled",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

const EMPTY_FORM = {
  id: "",
  title: "",
  description: "",
  priority: "MEDIUM" as TaskPriority,
  status: "PENDING" as TaskStatus,
  visibility: "PRIVATE" as TaskVisibility,
  assigned_to_id: "",
  due_date: "",
  related_entity_type: "",
  related_entity_id: "",
};

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`badge-status badge-status-${status.toLowerCase()}`}>
      {STATUS_BADGES[status] || status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className={`badge-priority badge-priority-${priority.toLowerCase()}`}>
      {PRIORITY_LABELS[priority] || priority}
    </span>
  );
}

/** PUBLIC: visible to everyone. PRIVATE (default): creator & assignee only. */
function VisibilityBadge({ visibility }: { visibility?: TaskVisibility }) {
  const isPublic = visibility === "PUBLIC";
  return (
    <span
      style={{
        fontSize: "11.5px",
        padding: "3px 8px",
        background: isPublic ? "#eff6ff" : "#f3f4f6",
        color: isPublic ? "#1d4ed8" : "#4b5563",
        borderRadius: "4px",
        fontWeight: 600,
      }}
    >
      {isPublic ? "🌐 Public" : "🔒 Private"}
    </span>
  );
}

function formatDate(isoStr?: string | null): string {
  if (!isoStr) return "No due date";
  const dt = new Date(isoStr);
  if (isNaN(dt.getTime())) return "No due date";
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** ISO string -> the `YYYY-MM-DDTHH:mm` a datetime-local input expects. */
function toLocalISOString(dateInput?: string | null): string {
  if (!dateInput) return "";
  const dt = new Date(dateInput);
  if (isNaN(dt.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(
    dt.getHours()
  )}:${pad(dt.getMinutes())}`;
}

function capitalize(str?: string | null): string {
  if (!str) return "";
  if (str === "IN_PROGRESS") return "InProgress";
  if (str === "IN_REVIEW") return "InReview";
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  fontSize: "13.5px",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: 600,
  marginBottom: "6px",
};

export function TasksPage() {
  const { profile, hasPermission } = useAuth();
  const showToast = useToast();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<
    { id: string; username: string; email: string; display_name?: string | null; full_name?: string | null }[]
  >([]);
  const [view, setView] = useState<ViewMode>("list");
  const [preset, setPreset] = useState<Preset>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Row checkboxes + select-all. No bulk action reads this selection yet --
  // ported to match the source's list-view chrome, which wires the same
  // select-all-propagates-to-rows behavior without a bulk action attached.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const setField = <K extends keyof typeof EMPTY_FORM>(
    key: K,
    value: (typeof EMPTY_FORM)[K]
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const loadTasks = useCallback(async () => {
    setLoading(true);
    let loaded: Task[] = [];
    try {
      const res = await apiGet<ItemsPage<Task>>("/tasks?limit=100");
      loaded = res?.data && Array.isArray(res.data.items) ? res.data.items : [];
      setTasks(loaded);
      setError(null);
    } catch (err) {
      console.error("Failed to load tasks:", err);
      showToast(errorMessage(err) || "Failed to load tasks", "error");
      setTasks([]);
    } finally {
      setLoading(false);
    }

    // Anything past its due date and still open gets a prominent warning.
    const now = new Date();
    const overdue = loaded.filter((t) => {
      if (!t.due_date) return false;
      if (t.status === "COMPLETED" || t.status === "CANCELLED") return false;
      return new Date(t.due_date) < now;
    });
    if (overdue.length > 0) {
      const titles = overdue.map((t) => `"${t.title}"`).join(", ");
      showToast(
        `⚠️ Attention: ${overdue.length} task(s) are OVERDUE! (${titles})`,
        "warning",
        6000
      );
    }
  }, [showToast]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<ItemsPage<{ id: string; username: string; email: string; display_name?: string | null; full_name?: string | null }>>(
          "/users?limit=100"
        );
        if (res?.data && Array.isArray(res.data.items)) {
          setUsers(res.data.items);
        }
      } catch (err) {
        console.warn("Could not load users list for assignment (permission or offline):", err);
        // Fall back to just the current user, so a task can still be self-assigned.
        if (profile?.id) {
          setUsers([
            {
              id: profile.id,
              username: profile.username,
              email: "",
              display_name: `${profile.full_name || profile.username} (Me)`,
            },
          ]);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(
    () => ({
      total: tasks.length,
      active: tasks.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS").length,
      review: tasks.filter((t) => t.status === "IN_REVIEW").length,
      completed: tasks.filter((t) => t.status === "COMPLETED").length,
      urgent: tasks.filter((t) => t.priority === "URGENT" || t.priority === "HIGH").length,
    }),
    [tasks]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return tasks.filter((t) => {
      if (q) {
        const matchTitle = (t.title || "").toLowerCase().includes(q);
        const matchDesc = (t.description || "").toLowerCase().includes(q);
        const assignee = t.assigned_to;
        const matchAssignee = [assignee?.username, assignee?.display_name, assignee?.full_name]
          .some((v) => (v || "").toLowerCase().includes(q));
        if (!matchTitle && !matchDesc && !matchAssignee) return false;
      }
      if (statusFilter && t.status !== statusFilter) return false;
      if (priorityFilter && t.priority !== priorityFilter) return false;

      if (preset === "my_assigned") {
        if (!profile || t.assigned_to_id !== profile.id) return false;
      } else if (preset === "my_created") {
        if (!profile || t.created_by_id !== profile.id) return false;
      } else if (preset === "urgent") {
        if (t.priority !== "URGENT" && t.priority !== "HIGH") return false;
      }
      return true;
    });
  }, [tasks, search, statusFilter, priorityFilter, preset, profile]);

  function openCreateModal() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEditModal(task: Task) {
    setForm({
      id: task.id,
      title: task.title || "",
      description: task.description || "",
      priority: task.priority || "MEDIUM",
      status: task.status || "PENDING",
      visibility: task.visibility || "PRIVATE",
      assigned_to_id: task.assigned_to_id || "",
      due_date: toLocalISOString(task.due_date),
      related_entity_type: task.related_entity_type || "",
      related_entity_id: task.related_entity_id || "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);

    const due_date = form.due_date ? new Date(form.due_date).toISOString() : null;
    const base = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      priority: form.priority,
      visibility: form.visibility,
      assigned_to_id: form.assigned_to_id || null,
      due_date,
      related_entity_type: form.related_entity_type || null,
      related_entity_id: form.related_entity_id.trim() || null,
    };

    try {
      if (form.id) {
        await apiPatch(`/tasks/${form.id}`, { ...base, status: form.status });
        showToast("Task updated successfully", "success");
      } else {
        await apiPost("/tasks", base);
        showToast("Task created successfully", "success");
      }
      setFormOpen(false);
      await loadTasks();
    } catch (err) {
      setFormError(err);
    } finally {
      setSaving(false);
    }
  }

  async function updateStatusDirect(newStatus: TaskStatus) {
    if (!selectedTask) return;
    try {
      await apiPatch(`/tasks/${selectedTask.id}`, { status: newStatus });
      showToast(`Task status updated to ${newStatus}`, "success");
      setSelectedTask({ ...selectedTask, status: newStatus });
      await loadTasks();
    } catch (err) {
      showToast(errorMessage(err) || "Failed to update status", "error");
    }
  }

  async function deleteTask(taskId: string, taskTitle: string) {
    if (!confirm(`Are you sure you want to delete task "${taskTitle}"?`)) return;
    try {
      await apiDelete(`/tasks/${taskId}`);
      showToast("Task deleted successfully", "success");
      if (selectedTask?.id === taskId) setSelectedTask(null);
      await loadTasks();
    } catch (err) {
      showToast(errorMessage(err) || "Failed to delete task", "error");
    }
  }

  const canUpdate = hasPermission("task.update");
  const canDelete = hasPermission("task.delete");

  return (
    <AppShell activeKey="tasks" pageClassName="page-tasks">
      <main className="page">
        <Breadcrumb trail={["Tasks"]} />

        <div className="page-header">
          <div>
            <h1>Tasks &amp; Work Management</h1>
            <div className="page-subtitle">
              Track project tasks, set priorities, assign team members, and monitor progress.
            </div>
          </div>
          <div className="page-header-actions">
            <Can permission="task.create">
              <button className="btn btn-primary" onClick={openCreateModal}>
                <IconPlus style={{ marginRight: "6px" }} />
                New Task
              </button>
            </Can>
          </div>
        </div>

        <Banner error={error} />

        <div className="task-stats-grid">
          <div className="task-stat-card">
            <span className="label">Total Tasks</span>
            <span className="value">{stats.total}</span>
            <span className="subtext">All assigned work items</span>
          </div>
          <div className="task-stat-card">
            <span className="label">Pending / In Progress</span>
            <span className="value" style={{ color: "#2563eb" }}>
              {stats.active}
            </span>
            <span className="subtext">Active tasks being worked on</span>
          </div>
          <div className="task-stat-card">
            <span className="label">In Review</span>
            <span className="value" style={{ color: "#7c3aed" }}>
              {stats.review}
            </span>
            <span className="subtext">Awaiting feedback/approval</span>
          </div>
          <div className="task-stat-card">
            <span className="label">Completed</span>
            <span className="value" style={{ color: "#16a34a" }}>
              {stats.completed}
            </span>
            <span className="subtext">Successfully finished tasks</span>
          </div>
          <div className="task-stat-card">
            <span className="label">Urgent / Overdue</span>
            <span className="value" style={{ color: "#dc2626" }}>
              {stats.urgent}
            </span>
            <span className="subtext">Requires immediate attention</span>
          </div>
        </div>

        <div className="task-toolbar">
          <div className="task-toolbar-left">
            <div className="preset-pills">
              {(
                [
                  ["all", "All Tasks"],
                  ["my_assigned", "Assigned to Me"],
                  ["my_created", "Created by Me"],
                  ["urgent", "Urgent"],
                ] as [Preset, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={`preset-pill-btn ${preset === value ? "active" : ""}`}
                  onClick={() => setPreset(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ position: "relative", minWidth: "220px" }}>
              <input
                type="text"
                placeholder="Search tasks by title or details..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: "100%",
                  padding: "7px 12px",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "13px",
                }}
              />
            </div>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{
                padding: "7px 10px",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                fontSize: "13px",
              }}
            >
              <option value="">All Statuses</option>
              <option value="PENDING">Pending</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="IN_REVIEW">In Review</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>

            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              style={{
                padding: "7px 10px",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                fontSize: "13px",
              }}
            >
              <option value="">All Priorities</option>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </div>

          <div className="task-toolbar-right">
            <div className="view-switch-btns">
              <button
                className={`view-switch-btn ${view === "list" ? "active" : ""}`}
                onClick={() => setView("list")}
              >
                <IconListView />
                List
              </button>
              <button
                className={`view-switch-btn ${view === "kanban" ? "active" : ""}`}
                onClick={() => setView("kanban")}
              >
                <IconKanbanView />
                Kanban
              </button>
            </div>
          </div>
        </div>

        {/* ======================= LIST VIEW ======================= */}
        {view === "list" && (
          <div className="card">
            <div className="table-container" style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: "40px" }}>
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && selectedIds.size === filtered.length}
                        onChange={(e) => {
                          setSelectedIds(
                            e.target.checked ? new Set(filtered.map((t) => t.id)) : new Set()
                          );
                        }}
                      />
                    </th>
                    <th>Task Title</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Assignee</th>
                    <th>Due Date</th>
                    <th>Created By</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td
                        colSpan={8}
                        style={{ textAlign: "center", padding: "40px", color: "var(--color-muted)" }}
                      >
                        Loading tasks...
                      </td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        style={{ textAlign: "center", padding: "40px", color: "var(--color-muted)" }}
                      >
                        No tasks match your criteria.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((t) => {
                      const assigneeName = t.assigned_to
                        ? t.assigned_to.display_name || t.assigned_to.full_name || t.assigned_to.username
                        : "Unassigned";
                      const creatorName = t.created_by
                        ? t.created_by.display_name || t.created_by.full_name || t.created_by.username
                        : "System";
                      return (
                        <tr key={t.id}>
                          <td onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(t.id)}
                              onChange={(e) => {
                                setSelectedIds((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(t.id);
                                  else next.delete(t.id);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <td>
                            <div
                              style={{
                                fontWeight: 600,
                                color: "var(--color-text)",
                                fontSize: "14px",
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                              onClick={() => setSelectedTask(t)}
                            >
                              {t.title}
                              <VisibilityBadge visibility={t.visibility} />
                            </div>
                            {t.description && (
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "var(--color-muted)",
                                  maxWidth: "340px",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {t.description}
                              </div>
                            )}
                          </td>
                          <td>
                            <StatusBadge status={t.status} />
                          </td>
                          <td>
                            <PriorityBadge priority={t.priority} />
                          </td>
                          <td>
                            <div className="kanban-card-user">
                              <div className="avatar-xs">{initials(assigneeName)}</div>
                              <span>{assigneeName}</span>
                            </div>
                          </td>
                          <td style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
                            {formatDate(t.due_date)}
                          </td>
                          <td style={{ fontSize: "12.5px", color: "var(--color-muted)" }}>
                            {creatorName}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "inline-flex", gap: "6px" }}>
                              <button
                                className="btn btn-secondary"
                                style={{ padding: "4px 8px", fontSize: "12px" }}
                                onClick={() => setSelectedTask(t)}
                              >
                                View
                              </button>
                              {canUpdate && (
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: "4px 8px", fontSize: "12px" }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openEditModal(t);
                                  }}
                                >
                                  Edit
                                </button>
                              )}
                              {canDelete && (
                                <button
                                  className="btn btn-secondary"
                                  style={{
                                    padding: "4px 8px",
                                    fontSize: "12px",
                                    color: "var(--color-danger)",
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void deleteTask(t.id, t.title);
                                  }}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ======================= KANBAN VIEW ======================= */}
        {view === "kanban" && (
          <div>
            <div className="kanban-board">
              {STAGES.map((stage) => {
                const stageTasks = filtered.filter((t) => t.status === stage);
                return (
                  <div className="kanban-column" key={stage}>
                    <div className="kanban-header">
                      <span>{STAGE_LABELS[stage]}</span>
                      <span className="kanban-count">{stageTasks.length}</span>
                    </div>
                    <div className="kanban-cards">
                      {stageTasks.length === 0 ? (
                        <div
                          style={{
                            textAlign: "center",
                            padding: "20px 10px",
                            color: "var(--color-muted)",
                            fontSize: "12px",
                            border: "1px dashed var(--color-border)",
                            borderRadius: "var(--radius-sm)",
                          }}
                        >
                          No tasks
                        </div>
                      ) : (
                        stageTasks.map((t) => {
                          const assigneeName = t.assigned_to
                            ? t.assigned_to.display_name || t.assigned_to.full_name || t.assigned_to.username
                            : "Unassigned";
                          return (
                            <div
                              className="kanban-card"
                              key={t.id}
                              onClick={() => setSelectedTask(t)}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "8px",
                                }}
                              >
                                <PriorityBadge priority={t.priority} />
                                <span style={{ fontSize: "11px", color: "var(--color-muted)" }}>
                                  {formatDate(t.due_date)}
                                </span>
                              </div>
                              <div className="kanban-card-title">{t.title}</div>
                              {t.description && (
                                <div className="kanban-card-desc">{t.description}</div>
                              )}
                              <div className="kanban-card-meta">
                                <div className="kanban-card-user">
                                  <div className="avatar-xs">{initials(assigneeName)}</div>
                                  <span>{assigneeName}</span>
                                </div>
                                <button
                                  className="btn btn-secondary"
                                  style={{ padding: "2px 6px", fontSize: "11px" }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedTask(t);
                                  }}
                                >
                                  Details
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* ======================= TASK FORM MODAL ======================= */}
      <div className={`modal-overlay ${formOpen ? "active" : ""}`}>
        <div className="modal-content">
          <div className="modal-header">
            <h2>{form.id ? "Edit Task" : "Create New Task"}</h2>
            <button
              type="button"
              className="btn-close"
              style={{
                border: "none",
                background: "none",
                fontSize: "20px",
                cursor: "pointer",
                color: "var(--color-muted)",
              }}
              onClick={() => setFormOpen(false)}
            >
              &times;
            </button>
          </div>
          <form onSubmit={handleSave}>
            <div className="modal-body">
              <Banner error={formError} />

              <div>
                <label style={labelStyle}>
                  Task Title <span style={{ color: "var(--color-danger)" }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Follow up on supplier quotation, review inventory audit"
                  style={{ ...inputStyle, fontSize: "14px" }}
                  value={form.title}
                  onChange={(e) => setField("title", e.target.value)}
                />
              </div>

              <div>
                <label style={labelStyle}>Description / Guidelines</label>
                <textarea
                  rows={4}
                  placeholder="Add detailed instructions, reference links, or notes..."
                  style={{ ...inputStyle, fontFamily: "inherit" }}
                  value={form.description}
                  onChange={(e) => setField("description", e.target.value)}
                />
              </div>

              <div className="form-row-2">
                <div>
                  <label style={labelStyle}>Priority</label>
                  <select
                    style={inputStyle}
                    value={form.priority}
                    onChange={(e) => setField("priority", e.target.value as TaskPriority)}
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Status</label>
                  <select
                    style={inputStyle}
                    value={form.status}
                    onChange={(e) => setField("status", e.target.value as TaskStatus)}
                  >
                    <option value="PENDING">Pending</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="IN_REVIEW">In Review</option>
                    <option value="COMPLETED">Completed</option>
                    <option value="CANCELLED">Cancelled</option>
                  </select>
                </div>
              </div>

              <div className="form-row-2">
                <div>
                  <label style={labelStyle}>Task Visibility</label>
                  <select
                    style={inputStyle}
                    value={form.visibility}
                    onChange={(e) => setField("visibility", e.target.value as TaskVisibility)}
                  >
                    <option value="PRIVATE">🔒 Private (Creator &amp; Assignee Only)</option>
                    <option value="PUBLIC">🌐 Public (Visible to Everyone)</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Assign To User</label>
                  <select
                    style={inputStyle}
                    value={form.assigned_to_id}
                    onChange={(e) => setField("assigned_to_id", e.target.value)}
                  >
                    <option value="">-- Select Assignee --</option>
                    {users.map((u) => {
                      const label = u.display_name || u.full_name || u.username;
                      return (
                        <option key={u.id} value={u.id}>
                          {label !== u.username ? `${label} (${u.username})` : label}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <div>
                <label style={labelStyle}>Due Date &amp; Time</label>
                <input
                  type="datetime-local"
                  style={{ ...inputStyle, padding: "8.5px 12px" }}
                  value={form.due_date}
                  onChange={(e) => setField("due_date", e.target.value)}
                />
              </div>

              <div className="form-row-2">
                <div>
                  <label style={labelStyle}>Related Module / Entity</label>
                  <select
                    style={inputStyle}
                    value={form.related_entity_type}
                    onChange={(e) => setField("related_entity_type", e.target.value)}
                  >
                    <option value="">None (General Task)</option>
                    <option value="supplier">Supplier Profile</option>
                    <option value="product">Product Catalog</option>
                    <option value="employee">Employee / HR</option>
                    <option value="organization">Organization</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Entity Reference ID / Code</label>
                  <input
                    type="text"
                    placeholder="e.g. SUP-0012, PROD-45"
                    style={inputStyle}
                    value={form.related_entity_id}
                    onChange={(e) => setField("related_entity_id", e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : "Save Task"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* ======================= TASK DETAIL MODAL ======================= */}
      <div className={`modal-overlay ${selectedTask ? "active" : ""}`}>
        <div className="modal-content" style={{ maxWidth: "680px" }}>
          {selectedTask && (
            <>
              <div className="modal-header">
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <StatusBadge status={selectedTask.status} />
                  <PriorityBadge priority={selectedTask.priority} />
                  <VisibilityBadge visibility={selectedTask.visibility} />
                </div>
                <button
                  type="button"
                  className="btn-close"
                  style={{
                    border: "none",
                    background: "none",
                    fontSize: "20px",
                    cursor: "pointer",
                    color: "var(--color-muted)",
                  }}
                  onClick={() => setSelectedTask(null)}
                >
                  &times;
                </button>
              </div>

              <div className="modal-body">
                <h2
                  style={{
                    fontSize: "20px",
                    fontWeight: 700,
                    margin: "0 0 10px 0",
                    color: "var(--color-text)",
                  }}
                >
                  {selectedTask.title}
                </h2>

                <div className="detail-section" style={{ marginBottom: "14px" }}>
                  <div className="detail-label">Description</div>
                  <div
                    className="detail-val"
                    style={{
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.5,
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {selectedTask.description || "No description provided."}
                  </div>
                </div>

                <div className="form-row-2" style={{ marginBottom: "14px" }}>
                  <div className="detail-section">
                    <div className="detail-label">Assignee</div>
                    <div className="detail-val" style={{ fontWeight: 600 }}>
                      {selectedTask.assigned_to
                        ? `${selectedTask.assigned_to.display_name || selectedTask.assigned_to.full_name || selectedTask.assigned_to.username} (${selectedTask.assigned_to.email})`
                        : "Unassigned"}
                    </div>
                  </div>
                  <div className="detail-section">
                    <div className="detail-label">Due Date</div>
                    <div className="detail-val">{formatDate(selectedTask.due_date)}</div>
                  </div>
                </div>

                <div className="form-row-2">
                  <div className="detail-section">
                    <div className="detail-label">Created By</div>
                    <div className="detail-val">
                      {selectedTask.created_by
                        ? selectedTask.created_by.display_name || selectedTask.created_by.full_name || selectedTask.created_by.username
                        : "System"}
                    </div>
                  </div>
                  <div className="detail-section">
                    <div className="detail-label">Created / Updated</div>
                    <div className="detail-val" style={{ fontSize: "12.5px" }}>
                      {`Created: ${formatDate(selectedTask.created_at)} | Updated: ${formatDate(
                        selectedTask.updated_at
                      )}`}
                    </div>
                  </div>
                </div>

                {selectedTask.related_entity_type && selectedTask.related_entity_id && (
                  <div className="detail-section" style={{ marginTop: "14px" }}>
                    <div className="detail-label">Related Reference</div>
                    <div className="detail-val">
                      {`${capitalize(selectedTask.related_entity_type)} — Ref: ${
                        selectedTask.related_entity_id
                      }`}
                    </div>
                  </div>
                )}

                <div
                  style={{
                    marginTop: "20px",
                    paddingTop: "16px",
                    borderTop: "1px solid var(--color-border)",
                  }}
                >
                  <div className="detail-label" style={{ marginBottom: "10px" }}>
                    Update Task Status
                  </div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button className="btn btn-secondary" onClick={() => updateStatusDirect("PENDING")}>
                      Mark Pending
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => updateStatusDirect("IN_PROGRESS")}
                    >
                      Start Work (In Progress)
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => updateStatusDirect("IN_REVIEW")}
                    >
                      Submit for Review
                    </button>
                    <button
                      className="btn btn-primary"
                      style={{
                        backgroundColor: "var(--color-success)",
                        borderColor: "var(--color-success)",
                      }}
                      onClick={() => updateStatusDirect("COMPLETED")}
                    >
                      Mark Complete
                    </button>
                    <button
                      className="btn btn-secondary"
                      style={{ color: "var(--color-danger)" }}
                      onClick={() => updateStatusDirect("CANCELLED")}
                    >
                      Cancel Task
                    </button>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <Can permission="task.update">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      const task = selectedTask;
                      setSelectedTask(null);
                      openEditModal(task);
                    }}
                  >
                    Edit Task
                  </button>
                </Can>
                <Can permission="task.delete">
                  <button
                    type="button"
                    className="btn btn-danger"
                    style={{
                      backgroundColor: "var(--color-danger)",
                      color: "#fff",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                    }}
                    onClick={() => void deleteTask(selectedTask.id, selectedTask.title)}
                  >
                    Delete Task
                  </button>
                </Can>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
