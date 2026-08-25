"""Company List FastAPI Router."""

from __future__ import annotations

import uuid
from typing import Any
from fastapi import APIRouter, Depends, File, Request, UploadFile, status
from fastapi.responses import Response

from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.masters.company_list.dependencies import get_company_service
from app.masters.company_list.schemas import (
    CompanyCreate,
    CompanyLookupRead,
    CompanyRead,
    CompanyUpdate,
    ImportSummaryRead,
)
from app.masters.company_list.service import CompanyService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/company-list", tags=["Masters - Company List"])


@router.get("", summary="List companies")
async def list_companies(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.view")),
) -> dict:
    """List companies with search/pagination."""
    companies, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [CompanyRead.model_validate(c).model_dump(mode="json") for c in companies]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get(
    "/lookup",
    summary="Lightweight id/name/branches lookup for organizations (no organizationlist.view required)",
)
async def lookup_companies(
    request: Request,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Return every active organization and its branches as bare objects.

    Gated on 'is logged in' only, NOT organizationlist.view.
    Shipment Planning, Product Master, etc. store organization and branch IDs
    and need to resolve those IDs to display names and filter tabs for a user
    who has permission to view that module's data, even if they don't have
    permission to manage the Organization master list itself.
    """
    companies = await service.list_all_dropdown()
    data = [
        {
            "id": str(c.id),
            "name": c.name,
            "code": c.code,
            "branches": c.branches or [],
        }
        for c in companies
    ]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/dropdown", summary="List companies for dropdowns")
async def list_companies_dropdown(
    request: Request,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return all active companies for dropdown options."""
    companies = await service.list_all_dropdown()
    data = [{"id": str(c.id), "name": c.name, "code": c.code, "branches": c.branches or []} for c in companies]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/export", summary="Export companies to CSV/Excel")
async def export_companies(
    request: Request,
    format: str = "csv",
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.export")),
) -> Response:
    """Export every organization/company as a CSV or XLSX file."""
    file_format = format.lower()
    if file_format not in ("csv", "xlsx"):
        file_format = "csv"
    content = await service.export_file(file_format)
    media_type = (
        "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    filename = f"organization-list.{file_format}"
    return Response(
        content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.post("/import", summary="Import companies from CSV/Excel")
async def import_companies(
    request: Request,
    file: UploadFile = File(...),
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.import")),
) -> dict:
    """Import organizations/companies from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{company_id}", summary="Get company by ID")
async def get_company(
    request: Request,
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Get a single company by ID (authenticated lookup)."""
    company = await service.get_by_id_or_raise(company_id)
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create company")
async def create_company(
    request: Request,
    payload: CompanyCreate,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.create")),
) -> dict:
    """Create a new master company."""
    company = await service.create(**payload.model_dump(exclude_unset=True))
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.patch("/{company_id}", summary="Update company")
async def update_company(
    request: Request,
    company_id: uuid.UUID,
    payload: CompanyUpdate,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.update")),
) -> dict:
    """Update an existing master company."""
    company = await service.update(company_id, **payload.model_dump(exclude_unset=True))
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource updated successfully.")


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete company")
async def delete_company(
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.delete")),
) -> Response:
    """Delete a company."""
    await service.delete(company_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{company_id}/activate", summary="Activate company")
async def activate_company(
    request: Request,
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.update")),
) -> dict:
    """Activate a company."""
    company = await service.activate(company_id)
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{company_id}/deactivate", summary="Deactivate company")
async def deactivate_company(
    request: Request,
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
    _current_user: CurrentUser = Depends(require_permission("organizationlist.update")),
) -> dict:
    """Deactivate a company."""
    company = await service.deactivate(company_id)
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)