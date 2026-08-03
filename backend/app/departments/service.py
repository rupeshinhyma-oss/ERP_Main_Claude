"""
Department Service.

Business logic for department CRUD: code uniqueness, parent-department
existence + circular-hierarchy prevention, and cache invalidation. Manager
existence is enforced at the database level (a FK to ``employees.id``);
an :class:`IntegrityError` from an invalid ``manager_id`` is translated
into a clean :class:`ConflictException`/:class:`BadRequestException`.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.departments.models import Department
from app.departments.repository import DepartmentRepository


class DepartmentService:
    """Orchestrates department management on top of :class:`DepartmentRepository`."""

    not_found_message = "Department not found."

    def __init__(
        self, repository: DepartmentRepository, session: AsyncSession, cache_manager: CacheManager
    ) -> None:
        """Bind this service to its repository, session (for rollback), and the cache manager."""
        self.repository = repository
        self.session = session
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, department_id: uuid.UUID) -> Department:
        """Fetch a department by ID or raise :class:`NotFoundException`."""
        department = await self.repository.get_by_id(department_id)
        if department is None:
            raise NotFoundException(self.not_found_message)
        return department

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Department], int]:
        """Return a page of departments matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def _validate_parent(
        self, department_id: uuid.UUID | None, parent_department_id: uuid.UUID | None
    ) -> None:
        """Ensure the parent department exists and this assignment introduces no cycle."""
        if parent_department_id is None:
            return
        if department_id is not None and parent_department_id == department_id:
            raise BadRequestException("A department cannot be its own parent.")
        parent = await self.repository.get_by_id(parent_department_id)
        if parent is None:
            raise BadRequestException("The specified parent department does not exist.")
        if department_id is None:
            return
        descendants = await self.repository.get_descendant_ids(department_id)
        if parent_department_id in descendants:
            raise ConflictException(
                "This parent assignment would create a circular department hierarchy."
            )

    async def create(self, **field_values: Any) -> Department:
        """Create a new department, validating code uniqueness and parent hierarchy."""
        code = field_values.get("code")
        if code and await self.repository.code_exists(code):
            raise ConflictException(f"Department code {code!r} is already in use.")
        await self._validate_parent(None, field_values.get("parent_department_id"))

        try:
            department = await self.repository.create(**field_values)
        except IntegrityError as exc:
            await self.session.rollback()
            raise BadRequestException(
                "Could not create department: the specified manager does not exist."
            ) from exc
        await self.cache_manager.invalidate_departments()
        return department

    async def update(self, department_id: uuid.UUID, **field_values: Any) -> Department:
        """Update an existing department, validating code uniqueness and parent hierarchy."""
        department = await self.get_by_id_or_raise(department_id)
        code = field_values.get("code")
        if code and await self.repository.code_exists(code, exclude_id=department_id):
            raise ConflictException(f"Department code {code!r} is already in use.")
        if "parent_department_id" in field_values:
            await self._validate_parent(department_id, field_values.get("parent_department_id"))

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            try:
                await self.repository.update(department, **changes)
            except IntegrityError as exc:
                await self.session.rollback()
                raise BadRequestException(
                    "Could not update department: the specified manager does not exist."
                ) from exc
        await self.cache_manager.invalidate_departments()
        return department

    async def delete(self, department_id: uuid.UUID) -> None:
        """Soft-delete a department."""
        department = await self.get_by_id_or_raise(department_id)
        await self.repository.delete(department)
        await self.cache_manager.invalidate_departments()
