/**
 * Task Management Frontend Module.
 * Bitrix24 / CRM / ERP style task management script.
 */

let allTasks = [];
let allUsers = [];
let activeView = "list"; // "list" | "kanban"
let activePreset = "all"; // "all" | "my_assigned" | "my_created" | "urgent"
let selectedTask = null;

// Initialization
document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadUsers();
  await loadTasks();
});

function setupEventListeners() {
  // Preset Pills
  document.querySelectorAll(".preset-pill-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".preset-pill-btn").forEach((b) => b.classList.remove("active"));
      e.target.classList.add("active");
      activePreset = e.target.dataset.preset;
      filterAndRender();
    });
  });

  // Search & Select Filters
  document.getElementById("taskSearchInput")?.addEventListener("input", filterAndRender);
  document.getElementById("statusFilterSelect")?.addEventListener("change", filterAndRender);
  document.getElementById("priorityFilterSelect")?.addEventListener("change", filterAndRender);

  // View Switcher
  document.getElementById("btnListView")?.addEventListener("click", () => switchView("list"));
  document.getElementById("btnKanbanView")?.addEventListener("click", () => switchView("kanban"));

  // Modal Triggers
  document.getElementById("createNewTaskBtn")?.addEventListener("click", openCreateModal);
  document.getElementById("closeModalBtn")?.addEventListener("click", closeModal);
  document.getElementById("cancelModalBtn")?.addEventListener("click", closeModal);
  document.getElementById("taskForm")?.addEventListener("submit", handleSaveTask);

  // Detail Modal Triggers
  document.getElementById("closeDetailModalBtn")?.addEventListener("click", closeDetailModal);
  document.getElementById("editFromDetailBtn")?.addEventListener("click", () => {
    if (!selectedTask) return;
    closeDetailModal();
    openEditModal(selectedTask);
  });
  document.getElementById("deleteFromDetailBtn")?.addEventListener("click", () => {
    if (!selectedTask) return;
    deleteTask(selectedTask.id, selectedTask.title);
  });
}

function switchView(viewName) {
  activeView = viewName;
  const listContainer = document.getElementById("listViewContainer");
  const kanbanContainer = document.getElementById("kanbanViewContainer");
  const btnList = document.getElementById("btnListView");
  const btnKanban = document.getElementById("btnKanbanView");

  if (viewName === "kanban") {
    listContainer.style.display = "none";
    kanbanContainer.style.display = "block";
    btnList.classList.remove("active");
    btnKanban.classList.add("active");
  } else {
    listContainer.style.display = "block";
    kanbanContainer.style.display = "none";
    btnList.classList.add("active");
    btnKanban.classList.remove("active");
  }
  filterAndRender();
}

async function loadUsers() {
  const selectEl = document.getElementById("taskAssignee");
  if (!selectEl) return;
  selectEl.innerHTML = `<option value="">-- Select Assignee --</option>`;
  try {
    const res = await apiGet("/users?limit=100");
    if (res && res.data && Array.isArray(res.data.items)) {
      allUsers = res.data.items;
      allUsers.forEach((u) => {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = `${u.username} (${u.email})`;
        selectEl.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn("Could not load users list for assignment (permission or offline):", err);
    // Fallback: Add self if logged in profile exists
    const profile = Auth.getProfile();
    if (profile && profile.id) {
      const opt = document.createElement("option");
      opt.value = profile.id;
      opt.textContent = `${profile.username} (Me)`;
      selectEl.appendChild(opt);
    }
  }
}

async function loadTasks() {
  const tbody = document.getElementById("tasksTbody");
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 40px; color: var(--color-muted);">Loading tasks...</td></tr>`;
  }
  try {
    const res = await apiGet("/tasks?limit=100");
    if (res && res.data && Array.isArray(res.data.items)) {
      allTasks = res.data.items;
    } else {
      allTasks = [];
    }
  } catch (err) {
    console.error("Failed to load tasks:", err);
    showToast(err.message || "Failed to load tasks", "error");
    allTasks = [];
  }
  updateStats();
  filterAndRender();

  // Check for overdue tasks and show warning toast
  const now = new Date();
  const overdueTasks = allTasks.filter((t) => {
    if (!t.due_date) return false;
    if (t.status === "COMPLETED" || t.status === "CANCELLED") return false;
    return new Date(t.due_date) < now;
  });

  if (overdueTasks.length > 0) {
    const titles = overdueTasks.map((t) => `"${t.title}"`).join(", ");
    showToast(`⚠️ Attention: ${overdueTasks.length} task(s) are OVERDUE! (${titles})`, "warning", 6000);
  }

  if (typeof window.loadNotifications === "function") {
    window.loadNotifications();
  }
}

function updateStats() {
  const statTotal = document.getElementById("statTotal");
  const statActive = document.getElementById("statActive");
  const statReview = document.getElementById("statReview");
  const statCompleted = document.getElementById("statCompleted");
  const statUrgent = document.getElementById("statUrgent");

  const total = allTasks.length;
  const active = allTasks.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS").length;
  const review = allTasks.filter((t) => t.status === "IN_REVIEW").length;
  const completed = allTasks.filter((t) => t.status === "COMPLETED").length;
  const urgent = allTasks.filter((t) => t.priority === "URGENT" || t.priority === "HIGH").length;

  if (statTotal) statTotal.textContent = total;
  if (statActive) statActive.textContent = active;
  if (statReview) statReview.textContent = review;
  if (statCompleted) statCompleted.textContent = completed;
  if (statUrgent) statUrgent.textContent = urgent;
}

function filterAndRender() {
  const q = (document.getElementById("taskSearchInput")?.value || "").toLowerCase().trim();
  const statusFilter = document.getElementById("statusFilterSelect")?.value || "";
  const priorityFilter = document.getElementById("priorityFilterSelect")?.value || "";
  const profile = Auth.getProfile();

  let filtered = allTasks.filter((t) => {
    // Search Query
    if (q) {
      const matchTitle = (t.title || "").toLowerCase().includes(q);
      const matchDesc = (t.description || "").toLowerCase().includes(q);
      const matchAssignee = (t.assigned_to?.username || "").toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchAssignee) return false;
    }

    // Status Filter
    if (statusFilter && t.status !== statusFilter) return false;

    // Priority Filter
    if (priorityFilter && t.priority !== priorityFilter) return false;

    // Preset Pills Filter
    if (activePreset === "my_assigned") {
      if (!profile || t.assigned_to_id !== profile.id) return false;
    } else if (activePreset === "my_created") {
      if (!profile || t.created_by_id !== profile.id) return false;
    } else if (activePreset === "urgent") {
      if (t.priority !== "URGENT" && t.priority !== "HIGH") return false;
    }

    return true;
  });

  if (activeView === "kanban") {
    renderKanbanView(filtered);
  } else {
    renderListView(filtered);
  }
}

function renderListView(tasks) {
  const tbody = document.getElementById("tasksTbody");
  if (!tbody) return;

  if (tasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 40px; color: var(--color-muted);">No tasks match your criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = tasks
    .map((t) => {
      const assigneeName = t.assigned_to ? escapeHtml(t.assigned_to.username) : "Unassigned";
      const creatorName = t.created_by ? escapeHtml(t.created_by.username) : "System";
      const dueDateFormatted = formatDate(t.due_date);

      return `
      <tr>
        <td class="cell-checkbox"><input type="checkbox" class="row-checkbox" value="${t.id}" /></td>
        <td>
          <div style="font-weight: 600; color: var(--color-text); font-size: 14px; cursor: pointer;" onclick="openTaskDetail('${t.id}')">
            ${escapeHtml(t.title)}
          </div>
          ${t.description ? `<div style="font-size: 12px; color: var(--color-muted); max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.description)}</div>` : ""}
        </td>
        <td>${getStatusBadge(t.status)}</td>
        <td>${getPriorityBadge(t.priority)}</td>
        <td>
          <div class="kanban-card-user">
            <div class="avatar-xs">${initials(assigneeName)}</div>
            <span>${assigneeName}</span>
          </div>
        </td>
        <td style="font-size: 13px; color: var(--color-text-secondary);">${dueDateFormatted}</td>
        <td style="font-size: 12.5px; color: var(--color-muted);">${creatorName}</td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 6px;">
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="openTaskDetail('${t.id}')">View</button>
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;" data-permission="task.update" onclick="event.stopPropagation(); openEditModalById('${t.id}')">Edit</button>
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; color: var(--color-danger);" data-permission="task.delete" onclick="event.stopPropagation(); deleteTask('${t.id}', '${escapeJsStr(t.title)}')">Delete</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  Auth.applyPermissionVisibility(tbody);
}

function renderKanbanView(tasks) {
  const stages = ["PENDING", "IN_PROGRESS", "IN_REVIEW", "COMPLETED", "CANCELLED"];

  stages.forEach((stage) => {
    const cardsContainer = document.getElementById(`cards${capitalize(stage)}`);
    const countEl = document.getElementById(`count${capitalize(stage)}`);

    const stageTasks = tasks.filter((t) => t.status === stage);
    if (countEl) countEl.textContent = stageTasks.length;

    if (!cardsContainer) return;

    if (stageTasks.length === 0) {
      cardsContainer.innerHTML = `<div style="text-align:center; padding: 20px 10px; color: var(--color-muted); font-size: 12px; border: 1px dashed var(--color-border); border-radius: var(--radius-sm);">No tasks</div>`;
      return;
    }

    cardsContainer.innerHTML = stageTasks
      .map((t) => {
        const assigneeName = t.assigned_to ? escapeHtml(t.assigned_to.username) : "Unassigned";
        const dueDateFormatted = formatDate(t.due_date);

        return `
        <div class="kanban-card" onclick="openTaskDetail('${t.id}')">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            ${getPriorityBadge(t.priority)}
            <span style="font-size: 11px; color: var(--color-muted);">${dueDateFormatted}</span>
          </div>
          <div class="kanban-card-title">${escapeHtml(t.title)}</div>
          ${t.description ? `<div class="kanban-card-desc">${escapeHtml(t.description)}</div>` : ""}
          <div class="kanban-card-meta">
            <div class="kanban-card-user">
              <div class="avatar-xs">${initials(assigneeName)}</div>
              <span>${assigneeName}</span>
            </div>
            <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 11px;" onclick="event.stopPropagation(); openTaskDetail('${t.id}')">Details</button>
          </div>
        </div>`;
      })
      .join("");
  });
}

// Helpers
function getStatusBadge(status) {
  const map = {
    PENDING: `<span class="badge-status badge-status-pending">⏳ Pending</span>`,
    IN_PROGRESS: `<span class="badge-status badge-status-in_progress">⚡ In Progress</span>`,
    IN_REVIEW: `<span class="badge-status badge-status-in_review">🔍 In Review</span>`,
    COMPLETED: `<span class="badge-status badge-status-completed">✅ Completed</span>`,
    CANCELLED: `<span class="badge-status badge-status-cancelled">🚫 Cancelled</span>`,
  };
  return map[status] || `<span class="badge-status">${status}</span>`;
}

function getPriorityBadge(priority) {
  const map = {
    LOW: `<span class="badge-priority badge-priority-low">Low</span>`,
    MEDIUM: `<span class="badge-priority badge-priority-medium">Medium</span>`,
    HIGH: `<span class="badge-priority badge-priority-high">High</span>`,
    URGENT: `<span class="badge-priority badge-priority-urgent">Urgent</span>`,
  };
  return map[priority] || `<span class="badge-priority">${priority}</span>`;
}

function formatDate(isoStr) {
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

function toLocalISOString(dateInput) {
  if (!dateInput) return "";
  const dt = new Date(dateInput);
  if (isNaN(dt.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function capitalize(str) {
  if (!str) return "";
  if (str === "IN_PROGRESS") return "InProgress";
  if (str === "IN_REVIEW") return "InReview";
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeJsStr(str) {
  if (!str) return "";
  return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
}

document.addEventListener("change", (e) => {
  if (e.target && (e.target.classList.contains("select-all-checkbox") || e.target.id === "selectAll")) {
    const isChecked = e.target.checked;
    const table = e.target.closest("table");
    if (table) {
      table.querySelectorAll(".row-checkbox").forEach((cb) => {
        cb.checked = isChecked;
      });
    }
  }
});

function initViewSwitcher() {
  if (!name) return "?";
  return name.trim().slice(0, 2).toUpperCase();
}

// Modal Handlers
function openCreateModal() {
  document.getElementById("taskId").value = "";
  document.getElementById("modalTitle").textContent = "Create New Task";
  document.getElementById("taskTitle").value = "";
  document.getElementById("taskDescription").value = "";
  document.getElementById("taskPriority").value = "MEDIUM";
  document.getElementById("taskStatus").value = "PENDING";
  document.getElementById("taskAssignee").value = "";
  document.getElementById("taskDueDate").value = "";
  document.getElementById("taskRelatedType").value = "";
  document.getElementById("taskRelatedId").value = "";
  document.getElementById("modalError").innerHTML = "";

  document.getElementById("taskModal").classList.add("active");
}

function openEditModalById(taskId) {
  const task = allTasks.find((t) => t.id === taskId);
  if (task) openEditModal(task);
}

function openEditModal(task) {
  document.getElementById("taskId").value = task.id;
  document.getElementById("modalTitle").textContent = "Edit Task";
  document.getElementById("taskTitle").value = task.title || "";
  document.getElementById("taskDescription").value = task.description || "";
  document.getElementById("taskPriority").value = task.priority || "MEDIUM";
  document.getElementById("taskStatus").value = task.status || "PENDING";
  document.getElementById("taskAssignee").value = task.assigned_to_id || "";

  if (task.due_date) {
    document.getElementById("taskDueDate").value = toLocalISOString(task.due_date);
  } else {
    document.getElementById("taskDueDate").value = "";
  }

  document.getElementById("taskRelatedType").value = task.related_entity_type || "";
  document.getElementById("taskRelatedId").value = task.related_entity_id || "";
  document.getElementById("modalError").innerHTML = "";

  document.getElementById("taskModal").classList.add("active");
}

function closeModal() {
  document.getElementById("taskModal").classList.remove("active");
}

async function handleSaveTask(e) {
  e.preventDefault();
  const taskId = document.getElementById("taskId").value;
  const title = document.getElementById("taskTitle").value.trim();
  const description = document.getElementById("taskDescription").value.trim() || null;
  const priority = document.getElementById("taskPriority").value;
  const status = document.getElementById("taskStatus").value;
  const assigneeVal = document.getElementById("taskAssignee").value;
  const assigned_to_id = assigneeVal ? assigneeVal : null;
  const dueDateVal = document.getElementById("taskDueDate").value;
  const due_date = dueDateVal ? new Date(dueDateVal).toISOString() : null;
  const related_entity_type = document.getElementById("taskRelatedType").value || null;
  const related_entity_id = document.getElementById("taskRelatedId").value.trim() || null;

  const btn = document.getElementById("saveTaskBtn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  const errEl = document.getElementById("modalError");
  errEl.innerHTML = "";

  try {
    if (taskId) {
      // Patch update
      const payload = {
        title,
        description,
        priority,
        status,
        assigned_to_id,
        due_date,
        related_entity_type,
        related_entity_id,
      };
      await apiPatch(`/tasks/${taskId}`, payload);
      showToast("Task updated successfully", "success");
    } else {
      // Create new
      const payload = {
        title,
        description,
        priority,
        due_date,
        assigned_to_id,
        related_entity_type,
        related_entity_id,
      };
      await apiPost("/tasks", payload);
      showToast("Task created successfully", "success");
    }
    closeModal();
    await loadTasks();
  } catch (err) {
    showError(errEl, err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Task";
  }
}

// Task Detail View
function openTaskDetail(taskId) {
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) return;

  selectedTask = task;

  document.getElementById("detailTitle").textContent = task.title;
  document.getElementById("detailDescription").textContent = task.description || "No description provided.";
  document.getElementById("detailStatusBadge").innerHTML = getStatusBadge(task.status);
  document.getElementById("detailPriorityBadge").innerHTML = getPriorityBadge(task.priority);
  document.getElementById("detailAssignee").textContent = task.assigned_to ? `${task.assigned_to.username} (${task.assigned_to.email})` : "Unassigned";
  document.getElementById("detailDueDate").textContent = formatDate(task.due_date);
  document.getElementById("detailCreatedBy").textContent = task.created_by ? `${task.created_by.username}` : "System";

  const createdStr = formatDate(task.created_at);
  const updatedStr = formatDate(task.updated_at);
  document.getElementById("detailTimestamps").textContent = `Created: ${createdStr} | Updated: ${updatedStr}`;

  const relatedSec = document.getElementById("detailRelatedSection");
  if (task.related_entity_type && task.related_entity_id) {
    relatedSec.style.display = "block";
    document.getElementById("detailRelatedInfo").textContent = `${capitalize(task.related_entity_type)} — Ref: ${task.related_entity_id}`;
  } else {
    relatedSec.style.display = "none";
  }

  const modal = document.getElementById("taskDetailModal");
  Auth.applyPermissionVisibility(modal);
  modal.classList.add("active");
}

function closeDetailModal() {
  document.getElementById("taskDetailModal").classList.remove("active");
  selectedTask = null;
}

window.updateTaskStatusDirect = async function (newStatus) {
  if (!selectedTask) return;
  try {
    await apiPatch(`/tasks/${selectedTask.id}`, { status: newStatus });
    showToast(`Task status updated to ${newStatus}`, "success");
    selectedTask.status = newStatus;
    document.getElementById("detailStatusBadge").innerHTML = getStatusBadge(newStatus);
    await loadTasks();
  } catch (err) {
    showToast(err.message || "Failed to update status", "error");
  }
};

async function deleteTask(taskId, taskTitle) {
  if (!confirm(`Are you sure you want to delete task "${taskTitle}"?`)) return;
  try {
    await apiDelete(`/tasks/${taskId}`);
    showToast("Task deleted successfully", "success");
    if (selectedTask && selectedTask.id === taskId) {
      closeDetailModal();
    }
    await loadTasks();
  } catch (err) {
    showToast(err.message || "Failed to delete task", "error");
  }
}
