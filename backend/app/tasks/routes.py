"""
Task Management Routes.

Implements the Task Management REST API: create task, list tasks with filters/search/pagination,
get task detail, update task, and delete task.
Gated by RBAC permissions via require_permission().
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.common.pagination import PageParams
from app.core.responses import build_success_response
from app.rbac.dependencies import require_permission
from app.tasks.dependencies import get_task_service
from app.tasks.models import TaskPriority, TaskStatus
from app.tasks.schemas import TaskCreate, TaskRead, TaskUpdate
from app.tasks.service import TaskService

router = APIRouter(prefix="/tasks", tags=["Tasks"])


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a new task")
async def create_task(
    payload: TaskCreate,
    request: Request,
    task_service: TaskService = Depends(get_task_service),
    current_user: CurrentUser = Depends(require_permission("task.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new task assigned to a user with priority and due date."""
    task = await task_service.create_task(
        title=payload.title,
        description=payload.description,
        priority=payload.priority,
        due_date=payload.due_date,
        assigned_to_id=payload.assigned_to_id,
        created_by_id=current_user.id,
        related_entity_type=payload.related_entity_type,
        related_entity_id=payload.related_entity_id,
    )
    data = TaskRead.model_validate(task).model_dump(mode="json")
    await audit_service.record(
        action=AuditAction.CREATE,
        module="tasks",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Task",
        entity_id=str(task.id),
        new_values={
            "title": task.title,
            "status": task.status.value,
            "priority": task.priority.value,
            "assigned_to_id": str(task.assigned_to_id) if task.assigned_to_id else None,
        },
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_201_CREATED,
        description=f"Created task {task.title!r}.",
    )
    request.state.audit_logged = True
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("", summary="List tasks with filters and pagination")
async def list_tasks(
    request: Request,
    page_params: PageParams = Depends(),
    status_filter: TaskStatus | None = Query(default=None, alias="status"),
    priority_filter: TaskPriority | None = Query(default=None, alias="priority"),
    assigned_to_id: uuid.UUID | None = Query(default=None),
    created_by_id: uuid.UUID | None = Query(default=None),
    q: str | None = Query(default=None, description="Search query across task title and description"),
    task_service: TaskService = Depends(get_task_service),
    _current_user: CurrentUser = Depends(require_permission("task.view")),
) -> dict:
    """List tasks, filtered and paginated."""
    tasks, total = await task_service.list_tasks(
        offset=page_params.offset,
        limit=page_params.limit,
        status=status_filter,
        priority=priority_filter,
        assigned_to_id=assigned_to_id,
        created_by_id=created_by_id,
        search_query=q,
    )
    data = {
        "items": [TaskRead.model_validate(t).model_dump(mode="json") for t in tasks],
        "total": total,
        "offset": page_params.offset,
        "limit": page_params.limit,
    }
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{task_id}", summary="Get task detail")
async def get_task(
    task_id: uuid.UUID,
    request: Request,
    task_service: TaskService = Depends(get_task_service),
    _current_user: CurrentUser = Depends(require_permission("task.view")),
) -> dict:
    """Fetch a single task by ID."""
    task = await task_service.get_by_id_or_raise(task_id)
    data = TaskRead.model_validate(task).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{task_id}", summary="Update a task")
async def update_task(
    task_id: uuid.UUID,
    payload: TaskUpdate,
    request: Request,
    task_service: TaskService = Depends(get_task_service),
    current_user: CurrentUser = Depends(require_permission("task.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update task fields, status, priority, due date, or assignee."""
    task = await task_service.update_task(
        task_id,
        title=payload.title,
        description=payload.description,
        status=payload.status,
        priority=payload.priority,
        due_date=payload.due_date,
        assigned_to_id=payload.assigned_to_id,
        related_entity_type=payload.related_entity_type,
        related_entity_id=payload.related_entity_id,
    )
    await audit_service.record(
        action=AuditAction.UPDATE,
        module="tasks",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Task",
        entity_id=str(task_id),
        new_values=payload.model_dump(exclude_unset=True, mode="json"),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Updated task {task.title!r}.",
    )
    request.state.audit_logged = True
    data = TaskRead.model_validate(task).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{task_id}", summary="Delete a task")
async def delete_task(
    task_id: uuid.UUID,
    request: Request,
    task_service: TaskService = Depends(get_task_service),
    current_user: CurrentUser = Depends(require_permission("task.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Delete a task."""
    task = await task_service.get_by_id_or_raise(task_id)
    await task_service.delete_task(task_id)
    await audit_service.record(
        action=AuditAction.DELETE,
        module="tasks",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Task",
        entity_id=str(task_id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Deleted task {task.title!r}.",
    )
    request.state.audit_logged = True
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
