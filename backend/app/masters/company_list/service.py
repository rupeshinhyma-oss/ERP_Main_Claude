"""Company List Service Layer."""

from __future__ import annotations

import uuid
from typing import Any, Sequence

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import ConflictException, NotFoundException
from app.masters.company_list.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.company_list.models import MasterCompany
from app.masters.company_list.repository import CompanyRepository
from app.masters.company_list.validators import validate_company_row
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)


class CompanyService:
    """Service layer orchestrating Company List operations."""

    not_found_message = "Company not found."

    def __init__(self, repository: CompanyRepository, cache_manager: CacheManager) -> None:
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, company_id: uuid.UUID) -> MasterCompany:
        """Fetch a company by ID or raise NotFoundException."""
        item = await self.repository.get_by_id(company_id)
        if not item:
            raise NotFoundException(self.not_found_message)
        return item

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[MasterCompany], int]:
        """Return a page of companies matching query parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_dropdown(self) -> Sequence[MasterCompany]:
        """Return all companies for dropdown selection."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        companies = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, companies)
        return companies

    async def _invalidate_cache(self) -> None:
        """Invalidate cache on mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> MasterCompany:
        """Create a new company."""
        name = field_values.get("name")
        code = field_values.get("code")

        if name:
            clean_name = name.strip()
            field_values["name"] = clean_name
            existing = await self.repository.get_by_name(clean_name)
            if existing is not None:
                raise ConflictException(f"Company name {clean_name!r} is already in use.")

        if not code and name:
            clean_code = "".join(c.upper() for c in field_values["name"] if c.isalnum())[:10]
            code = f"CMP-{clean_code}" if clean_code else "CMP-GEN"
            counter = 1
            base_code = code
            while await self.repository.get_by_code(code) is not None:
                code = f"{base_code}{counter}"
                counter += 1
            field_values["code"] = code

        company = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return company

    async def update(self, company_id: uuid.UUID, **field_values: Any) -> MasterCompany:
        """Update an existing company."""
        company = await self.get_by_id_or_raise(company_id)
        name = field_values.get("name")
        code = field_values.get("code")

        if name:
            clean_name = name.strip()
            field_values["name"] = clean_name
            existing = await self.repository.get_by_name(clean_name)
            if existing is not None and existing.id != company_id:
                raise ConflictException(f"Company name {clean_name!r} is already in use.")

        if code:
            clean_code = code.strip()
            field_values["code"] = clean_code
            existing = await self.repository.get_by_code(clean_code)
            if existing is not None and existing.id != company_id:
                raise ConflictException(f"Company code {clean_code!r} is already in use.")

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(company, **changes)
        await self._invalidate_cache()
        return company

    async def delete(self, company_id: uuid.UUID) -> None:
        """Delete a company record."""
        company = await self.get_by_id_or_raise(company_id)
        await self.repository.delete(company)
        await self._invalidate_cache()

    async def activate(self, company_id: uuid.UUID) -> MasterCompany:
        """Activate a company."""
        return await self.update(company_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, company_id: uuid.UUID) -> MasterCompany:
        """Deactivate a company."""
        return await self.update(company_id, status=RecordStatus.INACTIVE)

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import companies from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> MasterCompany:
            name = field_values["name"]
            existing_by_name = await self.repository.get_by_name(name)
            if existing_by_name is not None:
                raise ConflictException(
                    f"Company name {name!r} already exists.", details={"existing": model_to_dict(existing_by_name)}
                )
            code = field_values.get("code")
            if code:
                existing_by_code = await self.repository.get_by_code(code)
                if existing_by_code is not None:
                    raise ConflictException(
                        f"Company code {code!r} already exists.",
                        details={"existing": model_to_dict(existing_by_code)},
                    )
            return await self.create(**field_values)

        summary = await run_import(rows, row_validator=validate_company_row, row_creator=_create, dedupe_keys=("name",))
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every company to CSV or XLSX bytes."""
        companies = await self.repository.list_all()
        rows = [
            {
                "id": str(c.id),
                "name": c.name,
                "code": c.code,
                "description": c.description,
                "branch_count": len(c.branches) if c.branches else 0,
                "status": c.status.value,
                "created_at": c.created_at.isoformat(),
                "updated_at": c.updated_at.isoformat(),
            }
            for c in companies
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Organization List")