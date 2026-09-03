"""
Reporting Routes.

Implements employee reporting-relationship management and the dynamic
organization chart data endpoint (Parts 5-8 and 18 of the upgrade brief).
Circular-reporting rejection (Part 7) surfaces here as a 409 Conflict --
see ``app.org_structure.reporting_service.ReportingService`` for the
actual graph-traversal validation.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.users.repository import UserRepository
from app.org_structure.dependencies import get_reporting_service
from app.org_structure.reporting_service import ReportingService
from app.org_structure.schemas import (
    OrgChartNode,
    ReassignDirectReportsRequest,
    ReportingRelationshipCreate,
    ReportingRelationshipRead,
    SetPrimaryManagerRequest,
)
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/reporting", tags=["Organization - Reporting Structure"])


async def _record_action(
    *, audit_service: AuditService, request: Request, action: AuditAction, actor: CurrentUser,
    entity_id: uuid.UUID | str, description: str, new_values: dict | None = None,
) -> None:
    """Shared helper: record a reporting-relationship action and mark the request as logged."""
    await audit_service.record(
        action=action, module="org_structure", user_id=actor.id, username_snapshot=actor.username,
        entity_type="EmployeeReportingRelationship", entity_id=str(entity_id), new_values=new_values,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"), request_id=request.state.request_id,
        http_method=request.method, endpoint=request.url.path, response_status=status.HTTP_200_OK,
        description=description,
    )
    request.state.audit_logged = True


@router.get("/direct-reports/{employee_id}", summary="List an employee's direct reports")
async def get_direct_reports(
    employee_id: uuid.UUID, request: Request, service: ReportingService = Depends(get_reporting_service),
    _current_user: CurrentUser = Depends(require_permission("reporting.view")),
) -> dict:
    """List everyone who currently reports to this employee (any active relationship type)."""
    reports = await service.list_direct_reports(employee_id)
    data = [ReportingRelationshipRead.model_validate(r).model_dump(mode="json") for r in reports]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/managers/{employee_id}", summary="List an employee's managers")
async def get_managers(
    employee_id: uuid.UUID, request: Request, service: ReportingService = Depends(get_reporting_service),
    _current_user: CurrentUser = Depends(require_permission("reporting.view")),
) -> dict:
    """List every manager this employee currently reports to (across relationship types/departments)."""
    managers = await service.list_managers(employee_id)
    data = [ReportingRelationshipRead.model_validate(r).model_dump(mode="json") for r in managers]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a reporting relationship")
async def create_reporting_relationship(
    payload: ReportingRelationshipCreate, request: Request,
    service: ReportingService = Depends(get_reporting_service),
    current_user: CurrentUser = Depends(require_permission("reporting.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Create an employee reporting relationship (Parts 5-8). Rejects (409):
    self-reporting, circular reporting anywhere in the graph, and exact
    duplicates. An employee may hold multiple simultaneous reporting lines
    of different types/departments (e.g. PRIMARY_REPORTING in Sales,
    FUNCTIONAL_REPORTING in Operations, to different managers).
    """
    relationship = await service.create_relationship(**payload.model_dump())
    data = ReportingRelationshipRead.model_validate(relationship).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.REPORTING_RELATIONSHIP_ADDED, actor=current_user,
        entity_id=relationship.id,
        description=f"Employee {payload.employee_id} now reports to {payload.manager_employee_id} ({payload.relationship_type.value}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.post("/set-manager/{employee_id}", summary="Set or move an employee's primary manager")
async def set_primary_manager(
    employee_id: uuid.UUID, payload: SetPrimaryManagerRequest, request: Request,
    service: ReportingService = Depends(get_reporting_service),
    current_user: CurrentUser = Depends(require_permission("reporting.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Set (or move) this employee's PRIMARY_REPORTING manager in one call --
    deactivates any existing primary-manager relationship first, then
    creates the new one, with the same self-report/circular-reporting
    checks as creating a relationship directly. This is what the
    drag-and-drop organization chart calls when a card is dropped onto a
    new manager's card.
    """
    relationship = await service.set_primary_manager(employee_id, payload.manager_employee_id)
    data = ReportingRelationshipRead.model_validate(relationship).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.REPORTING_RELATIONSHIP_CHANGED, actor=current_user,
        entity_id=relationship.id,
        description=f"Set primary manager of {employee_id} to {payload.manager_employee_id} (org chart).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{relationship_id}", summary="Remove a reporting relationship")
async def remove_reporting_relationship(
    relationship_id: uuid.UUID, request: Request, service: ReportingService = Depends(get_reporting_service),
    current_user: CurrentUser = Depends(require_permission("reporting.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """End a reporting relationship (marks it INACTIVE; history is preserved per Part 14)."""
    await service.remove_relationship(relationship_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.REPORTING_RELATIONSHIP_REMOVED, actor=current_user,
        entity_id=relationship_id, description="Removed reporting relationship.",
    )
    return build_success_response(data={"removed": True}, request_id=request.state.request_id)


@router.post("/reassign-direct-reports/{manager_employee_id}", summary="Reassign a manager's direct reports")
async def reassign_direct_reports(
    manager_employee_id: uuid.UUID, payload: ReassignDirectReportsRequest, request: Request,
    service: ReportingService = Depends(get_reporting_service),
    current_user: CurrentUser = Depends(require_permission("reporting.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Move every active direct report of ``manager_employee_id`` to
    ``to_manager_employee_id`` (Part 15: use this before deactivating a
    manager, so no reporting relationship is left dangling).
    """
    count = await service.reassign_direct_reports(
        from_manager_employee_id=manager_employee_id, to_manager_employee_id=payload.to_manager_employee_id
    )
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.REPORTING_RELATIONSHIP_CHANGED, actor=current_user,
        entity_id=manager_employee_id,
        description=f"Reassigned {count} direct report(s) from {manager_employee_id} to {payload.to_manager_employee_id}.",
        new_values={"reassigned_count": count, "to_manager_employee_id": str(payload.to_manager_employee_id)},
    )
    return build_success_response(data={"reassigned_count": count}, request_id=request.state.request_id)


@router.get("/org-chart", summary="Get the dynamic organization chart data")
async def get_org_chart(
    request: Request, reporting_service: ReportingService = Depends(get_reporting_service),
    db: AsyncSession = Depends(get_db_session),
    _current_user: CurrentUser = Depends(require_permission("reporting.view")),
) -> dict:
    """
    Return the full set of active PRIMARY_REPORTING edges, with employee
    names resolved, so the frontend can render the org chart (Part 18).
    Built dynamically from the reporting-relationship graph -- no
    hierarchy levels are hardcoded anywhere in this response.
    """
    edges = await reporting_service.get_org_chart_edges()
    employees = {e.id: e for e in await UserRepository(db).list_all()}
    nodes = []
    for edge in edges:
        employee = employees.get(edge.employee_id)
        manager = employees.get(edge.manager_employee_id)
        nodes.append(
            OrgChartNode(
                employee_id=edge.employee_id,
                employee_name=employee.full_name if employee else str(edge.employee_id),
                manager_employee_id=edge.manager_employee_id,
                manager_name=manager.full_name if manager else str(edge.manager_employee_id),
                relationship_id=edge.id,
            )
        )
    # Include employees who have no manager recorded (chart roots, e.g. CEO/Owner)
    reported_ids = {n.employee_id for n in nodes}
    for employee in employees.values():
        if employee.id not in reported_ids:
            nodes.append(OrgChartNode(employee_id=employee.id, employee_name=employee.full_name))
    data = [n.model_dump(mode="json") for n in nodes]
    return build_success_response(data=data, request_id=request.state.request_id)