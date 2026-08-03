"""
Audit Admin Routes.

Read-only browsing API for the audit trail:

    GET /audit                  Paginated, searchable, sortable, filterable list.
    GET /audit/{audit_log_id}   A single entry.

There is deliberately no POST/PUT/PATCH/DELETE route here -- audit entries
are only ever created internally (by :class:`app.audit.middleware.AuditMiddleware`
and explicit service-layer calls), and per the Phase 3 retention
requirement, never modified or deleted by anyone, including via this API.
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
    audit_repository: AuditRepository = Depends(get_audit_repository),
    _current_user: CurrentUser = Depends(require_permission("audit.read")),
) -> dict:
    """List audit log entries, paginated/searchable/sortable/filterable (e.g. ``?action=LOGIN_FAILED``)."""
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
