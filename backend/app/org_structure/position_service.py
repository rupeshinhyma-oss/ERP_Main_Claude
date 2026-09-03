"""
Position Service.

Business logic for Position CRUD and employee<->position assignments
(Part 3 of the upgrade brief). Deliberately does not touch reporting
hierarchy or software permissions -- see ``app.org_structure.models``
module docstring.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.common.list_query import ListQueryParams
from app.core.exceptions import ConflictException, NotFoundException
from app.org_structure.assignments_repository import EmployeePositionAssignmentRepository
from app.org_structure.repository import PositionRepository
from app.org_structure.models import EmployeePositionAssignment, OrgRecordStatus, Position, PositionAssignmentType
from app.rbac.repository import RoleRepository
from app.users.repository import UserRepository


class PositionService:
    """Orchestrates position/designation management and employee position assignments."""

    not_found_message = "Position not found."

    def __init__(
        self,
        repository: PositionRepository,
        assignment_repository: EmployeePositionAssignmentRepository,
        employee_repository: UserRepository,
        department_repository: RoleRepository,
    ) -> None:
        """
        Bind this service to its repositories.

        ``employee_repository`` is a :class:`UserRepository` (Employee was
        merged into User -- see ``app.users.models.User`` docstring) --
        used to validate that an ``employee_id`` passed on a position
        assignment actually refers to an existing person.

        ``department_repository`` is a :class:`RoleRepository` (Role now
        doubles as Department, see the Department/Role merge notes in
        ``app.rbac.models``) -- used only to validate that a
        ``department_id`` passed on a position assignment actually refers
        to an existing department/role.
        """
        self.repository = repository
        self.assignment_repository = assignment_repository
        self.employee_repository = employee_repository
        self.department_repository = department_repository

    # --- Position CRUD --------------------------------------------------------------
    async def get_by_id_or_raise(self, position_id: uuid.UUID) -> Position:
        """Fetch a position by ID or raise :class:`NotFoundException`."""
        position = await self.repository.get_by_id(position_id)
        if position is None:
            raise NotFoundException(self.not_found_message)
        return position

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Position], int]:
        """Return a page of positions matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all(self) -> list[Position]:
        """Return every position (for dropdowns)."""
        return await self.repository.list_all()

    async def get_employee_counts(self, position_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
        """Return a mapping of position_id -> count of active assignments."""
        return await self.assignment_repository.count_for_positions(position_ids, active_only=True)

    async def create(self, **field_values: Any) -> Position:
        """Create a new position, validating name uniqueness."""
        name = field_values.get("name")
        if not name or not str(name).strip():
            raise ConflictException("Position name is required.")
        if await self.repository.name_exists(name):
            raise ConflictException(f"Position name {name!r} is already in use.")
        return await self.repository.create(**field_values)

    async def update(self, position_id: uuid.UUID, **field_values: Any) -> Position:
        """Update a position, validating name uniqueness."""
        position = await self.get_by_id_or_raise(position_id)
        name = field_values.get("name")
        if name and await self.repository.name_exists(name, exclude_id=position_id):
            raise ConflictException(f"Position name {name!r} is already in use.")
        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(position, **changes)
        return position

    async def delete(self, position_id: uuid.UUID) -> None:
        """Soft-delete a position, refusing if it has any active assignment."""
        position = await self.get_by_id_or_raise(position_id)
        active_assignments = await self.assignment_repository.list_for_position(position_id, active_only=True)
        if active_assignments:
            raise ConflictException(
                f"Cannot delete: {len(active_assignments)} employee(s) currently hold this position."
            )
        await self.repository.delete(position)

    async def activate(self, position_id: uuid.UUID) -> Position:
        """Set a position's status to ACTIVE (matches the standard MasterPage activate/deactivate contract)."""
        position = await self.get_by_id_or_raise(position_id)
        await self.repository.update(position, status=OrgRecordStatus.ACTIVE)
        return position

    async def deactivate(self, position_id: uuid.UUID) -> Position:
        """Set a position's status to INACTIVE."""
        position = await self.get_by_id_or_raise(position_id)
        await self.repository.update(position, status=OrgRecordStatus.INACTIVE)
        return position

    # --- Employee <-> Position assignments (Part 3) ---------------------------------
    async def list_position_holders(self, position_id: uuid.UUID) -> list[EmployeePositionAssignment]:
        """List every active employee assignment for a position."""
        await self.get_by_id_or_raise(position_id)
        return await self.assignment_repository.list_for_position(position_id, active_only=True)

    async def list_employee_positions(self, employee_id: uuid.UUID) -> list[EmployeePositionAssignment]:
        """List every position assignment held by an employee."""
        employee = await self.employee_repository.get_by_id(employee_id)
        if employee is None:
            raise NotFoundException("Employee not found.")
        return await self.assignment_repository.list_for_employee(employee_id)

    async def assign_employee(
        self,
        *,
        employee_id: uuid.UUID,
        position_id: uuid.UUID,
        department_id: uuid.UUID | None = None,
        assignment_type: PositionAssignmentType = PositionAssignmentType.PRIMARY,
        is_primary: bool = False,
        effective_from=None,
        effective_to=None,
    ) -> EmployeePositionAssignment:
        """
        Assign an employee to a position (Part 3). An employee may hold
        several positions simultaneously (PRIMARY/SECONDARY/ACTING/
        TEMPORARY) -- only an exact duplicate (employee, position,
        assignment_type) triple is rejected.
        """
        employee = await self.employee_repository.get_by_id(employee_id)
        if employee is None:
            raise NotFoundException("Employee not found.")
        await self.get_by_id_or_raise(position_id)
        if department_id is not None:
            department = await self.department_repository.get_by_id(department_id)
            if department is None:
                raise NotFoundException("Department not found.")

        existing = await self.assignment_repository.get_exact(employee_id, position_id, assignment_type)
        if existing is not None and existing.status == OrgRecordStatus.ACTIVE:
            raise ConflictException(
                f"This employee already has an active {assignment_type.value} assignment to this position."
            )

        if is_primary:
            await self.assignment_repository.clear_primary_flag(employee_id)

        if existing is not None:
            await self.assignment_repository.update(
                existing, status=OrgRecordStatus.ACTIVE, is_primary=is_primary,
                department_id=department_id, effective_from=effective_from, effective_to=effective_to,
            )
            return existing

        return await self.assignment_repository.create(
            employee_id=employee_id,
            position_id=position_id,
            department_id=department_id,
            assignment_type=assignment_type,
            is_primary=is_primary,
            effective_from=effective_from,
            effective_to=effective_to,
            status=OrgRecordStatus.ACTIVE,
        )

    async def remove_employee_assignment(self, assignment_id: uuid.UUID) -> None:
        """End an employee's position assignment (soft: marks INACTIVE, preserving history)."""
        assignment = await self.assignment_repository.get_by_id(assignment_id)
        if assignment is None:
            raise NotFoundException("Position assignment not found.")
        await self.assignment_repository.update(assignment, status=OrgRecordStatus.INACTIVE)