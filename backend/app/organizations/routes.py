"""Organization Routes. Manage the single company profile, gated by ``organization.manage``."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.organizations.dependencies import get_organization_service
from app.organizations.schemas import OrganizationCreate, OrganizationRead, OrganizationUpdate
from app.organizations.service import OrganizationService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/organizations", tags=["Organization"])


async def _record_org_action(
    *,
    audit_service: AuditService,
    request: Request,
    action: AuditAction,
    actor: CurrentUser,
    entity_id: str,
    description: str,
    new_values: dict | None = None,
) -> None:
    """Shared helper: record an organization-profile action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="organizations",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Organization",
        entity_id=entity_id,
        new_values=new_values,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=description,
    )
    request.state.audit_logged = True


from app.auth.dependencies import get_current_user
from app.rbac.dependencies import require_super_admin


@router.get("", summary="Get the organization profile")
async def get_organization(
    request: Request,
    organization_service: OrganizationService = Depends(get_organization_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch the single company profile. Accessible by all authenticated users for branding."""
    organization = await organization_service.get_or_raise()
    data = OrganizationRead.model_validate(organization).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create the organization profile")
async def create_organization(
    payload: OrganizationCreate,
    request: Request,
    organization_service: OrganizationService = Depends(get_organization_service),
    current_user: CurrentUser = Depends(require_super_admin()),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create the organization profile. Only one may ever exist. Restricted to Super Administrators."""
    organization = await organization_service.create(**payload.model_dump())
    data = OrganizationRead.model_validate(organization).model_dump(mode="json")
    await _record_org_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=str(organization.id),
        description=f"Created organization profile for {organization.company_name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.patch("", summary="Update the organization profile")
async def update_organization(
    payload: OrganizationUpdate,
    request: Request,
    organization_service: OrganizationService = Depends(get_organization_service),
    current_user: CurrentUser = Depends(require_super_admin()),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update the organization profile's fields. Restricted to Super Administrators."""
    organization = await organization_service.update(**payload.model_dump())
    data = OrganizationRead.model_validate(organization).model_dump(mode="json")
    await _record_org_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=str(organization.id),
        description=f"Updated organization profile for {organization.company_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)
