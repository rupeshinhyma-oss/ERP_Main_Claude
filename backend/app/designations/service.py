"""
Designation Service.

Business logic for designation CRUD: code uniqueness and cache
invalidation.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.exceptions import ConflictException, NotFoundException
from app.designations.models import Designation
from app.designations.repository import DesignationRepository


class DesignationService:
    """Orchestrates designation management on top of :class:`DesignationRepository`."""

    not_found_message = "Designation not found."

    def __init__(self, repository: DesignationRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the shared cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, designation_id: uuid.UUID) -> Designation:
        """Fetch a designation by ID or raise :class:`NotFoundException`."""
        designation = await self.repository.get_by_id(designation_id)
        if designation is None:
            raise NotFoundException(self.not_found_message)
        return designation

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Designation], int]:
        """Return a page of designations matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def create(self, **field_values: Any) -> Designation:
        """Create a new designation, validating code uniqueness."""
        code = field_values.get("code")
        if code and await self.repository.code_exists(code):
            raise ConflictException(f"Designation code {code!r} is already in use.")
        designation = await self.repository.create(**field_values)
        await self.cache_manager.invalidate_designations()
        return designation

    async def update(self, designation_id: uuid.UUID, **field_values: Any) -> Designation:
        """Update an existing designation, validating code uniqueness."""
        designation = await self.get_by_id_or_raise(designation_id)
        code = field_values.get("code")
        if code and await self.repository.code_exists(code, exclude_id=designation_id):
            raise ConflictException(f"Designation code {code!r} is already in use.")
        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(designation, **changes)
        await self.cache_manager.invalidate_designations()
        return designation

    async def delete(self, designation_id: uuid.UUID) -> None:
        """Delete a designation. ``Designation`` has no soft-delete mixin, so this is a hard delete."""
        designation = await self.get_by_id_or_raise(designation_id)
        await self.repository.delete(designation)
        await self.cache_manager.invalidate_designations()
