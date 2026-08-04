"""
Audit Admin Routes.

Read-only browsing API for the audit trail:

    GET /audit                  Paginated, searchable, sortable, filterable list.
    GET /audit/{audit_log_id}   A single entry.

There is deliberately no POST/PUT/PATCH/DELETE route here -- audit entries
are only ever created internally (by :class:`app.audit.middleware.AuditMiddleware`
and explicit service-layer calls), and per the Phase 3 retention
requirement, never modified or deleted by anyone, including via this API.

Every route requires ``audit.read``, a permission deliberately NOT granted
to the default 'employee' role seeded for regular team members (see
scripts/seed.py) -- so only super_admin (or any other role an admin
explicitly grants it to) can view the audit trail. Regular team members
get a 403 here, exactly as for any other admin-only endpoint.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request

from app.audit.dependencies import get_audit_repository
from app.audit.repository import AuditRepository
from app.audit.schemas import AuditLogRead
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.exceptions import NotFoundException
from app.core.responses import build_success_response
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/audit", tags=["Audit (admin)"])


@router.get("", summary="List audit log entries (admin)")
async def list_audit_logs(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    employee_name: str | None = None,
    employee_email: str | None = None,
    department_id: uuid.UUID | None = None,
    designation_id: uuid.UUID | None = None,
    audit_repository: AuditRepository = Depends(get_audit_repository),
    _current_user: CurrentUser = Depends(require_permission("audit.read")),
) -> dict:
    """
    List audit log entries, paginated/searchable/sortable/filterable
    (e.g. ``?action=LOGIN_FAILED``), with additional filters on the
    ACTING user's employee profile: ``employee_name`` (partial match on
    first/last/display name), ``employee_email`` (partial match),
    ``department_id``, ``designation_id`` -- every filter the Teams page
    needs, covering "employee name, email id, designation, departments
    and other whatever u have added" from the audit trail requirement.
    """
    if any([employee_name, employee_email, department_id, designation_id]):
        items, total = await audit_repository.paginated_list_with_actor_filters(
            query,
            employee_name=employee_name,
            employee_email=employee_email,
            department_id=department_id,
            designation_id=designation_id,
        )
    else:
        items, total = await audit_repository.paginated_list(query)
    data = [AuditLogRead.model_validate(item).model_dump(mode="json") for item in items]
    meta = PageMeta.build(
        page=query.page.page, page_size=query.page.page_size, total_records=total
    ).as_meta_dict()
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/{audit_log_id}", summary="Get a single audit log entry (admin)")
async def get_audit_log(
    audit_log_id: uuid.UUID,
    request: Request,
    audit_repository: AuditRepository = Depends(get_audit_repository),
    _current_user: CurrentUser = Depends(require_permission("audit.read")),
) -> dict:
    """Fetch a single audit log entry by ID."""
    entry = await audit_repository.get_by_id(audit_log_id)
    if entry is None:
        raise NotFoundException("Audit log entry not found.")
    data = AuditLogRead.model_validate(entry).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)