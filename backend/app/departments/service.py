"""
Department Service.

Business logic for department CRUD: code uniqueness, parent-department
existence + circular-hierarchy prevention, manager existence, and cache
invalidation.

Every foreign key and unique constraint is checked in application code
BEFORE the write, so the caller gets a message naming the field that is
actually wrong. The ``IntegrityError`` handler is a backstop for races
(two admins claiming one code at once) and attributes the failure by
inspecting the constraint name rather than assuming a cause.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.exceptions import (
    AppException,
    BadRequestException,
    ConflictException,
    NotFoundException,
)
from app.core.logging import get_logger
from app.departments.models import Department
from app.departments.repository import DepartmentRepository

logger = get_logger(__name__)


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

    @staticmethod
    def _describe_integrity_error(exc: IntegrityError, *, action: str) -> AppException:
        """
        Map an :class:`IntegrityError` to the constraint that actually failed.

        Previously every IntegrityError raised here was reported as "the
        specified manager does not exist", which is wrong for any other
        constraint -- most notably a duplicate ``code``, whose unique index
        spans soft-deleted rows the pre-check could not see. Blaming the
        manager for a code collision sends the user hunting through the
        employee list for a problem that was never there.

        The full driver message is logged (it can name schema internals) and
        only the identified constraint is surfaced to the caller.
        """
        detail = str(getattr(exc, "orig", exc))
        logger.warning("Department %s failed on a database constraint: %s", action, detail)
        lowered = detail.lower()

        if "fk_departments_manager_id" in lowered:
            return BadRequestException("The specified manager does not exist.")
        if "ix_departments_code" in lowered or "departments_code" in lowered:
            return ConflictException("That department code is already in use.")
        if "parent_department_id" in lowered:
            return BadRequestException("The specified parent department does not exist.")
        return ConflictException(
            f"Could not {action} department: the change violates a database constraint. "
            "Check the server log for the failing constraint."
        )

    async def _validate_manager(self, manager_id: uuid.UUID | None) -> None:
        """Ensure the manager, if given, is a live employee -- before the insert."""
        if manager_id is None:
            return
        if not await self.repository.manager_exists(manager_id):
            raise BadRequestException(
                "The specified manager does not exist or is no longer an active employee."
            )

    async def _validate_code(self, code: str | None, department_id: uuid.UUID | None = None) -> None:
        """
        Ensure ``code`` is free, counting soft-deleted departments as holders.

        An archived department still occupies its code in the unique index, so
        it gets its own message -- otherwise "already in use" is baffling when
        the Departments table appears empty.
        """
        if not code:
            return
        owner = await self.repository.code_owner(code, exclude_id=department_id)
        if owner is None:
            return
        if owner.is_deleted:
            raise ConflictException(
                f"Department code {code!r} is still held by a deleted department "
                f"({owner.name!r}). Choose a different code, or restore that department."
            )
        raise ConflictException(f"Department code {code!r} is already in use.")

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
        await self._validate_code(field_values.get("code"))
        await self._validate_parent(None, field_values.get("parent_department_id"))
        await self._validate_manager(field_values.get("manager_id"))

        try:
            department = await self.repository.create(**field_values)
        except IntegrityError as exc:
            await self.session.rollback()
            raise self._describe_integrity_error(exc, action="create") from exc
        await self.cache_manager.invalidate_departments()
        return department

    async def update(self, department_id: uuid.UUID, **field_values: Any) -> Department:
        """Update an existing department, validating code uniqueness and parent hierarchy."""
        department = await self.get_by_id_or_raise(department_id)
        await self._validate_code(field_values.get("code"), department_id)
        if "parent_department_id" in field_values:
            await self._validate_parent(department_id, field_values.get("parent_department_id"))
        if "manager_id" in field_values:
            await self._validate_manager(field_values.get("manager_id"))

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            try:
                await self.repository.update(department, **changes)
            except IntegrityError as exc:
                await self.session.rollback()
                raise self._describe_integrity_error(exc, action="update") from exc
        await self.cache_manager.invalidate_departments()
        return department

    async def delete(self, department_id: uuid.UUID) -> None:
        """Soft-delete a department."""
        department = await self.get_by_id_or_raise(department_id)
        await self.repository.delete(department)
        await self.cache_manager.invalidate_departments()