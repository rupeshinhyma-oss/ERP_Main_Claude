"""
Department Service.

Business logic for Department CRUD, employee<->department assignments,
and department leadership assignments. Position assignments live in
``app.org_structure.position_service`` and reporting relationships in
``app.org_structure.reporting_service`` -- kept separate since each has
its own distinct validation rules (Parts 2, 4, and 5-8 respectively).
"""

from __future__ import annotations

import uuid
from typing import Any

from app.common.list_query import ListQueryParams
from app.core.exceptions import ConflictException, NotFoundException
from app.employees.repository import EmployeeRepository
from app.org_structure.assignments_repository import (
    DepartmentLeadershipAssignmentRepository,
    EmployeeDepartmentAssignmentRepository,
)
from app.org_structure.models import (
    Department,
    DepartmentAssignmentType,
    DepartmentLeadershipAssignment,
    EmployeeDepartmentAssignment,
    LeadershipType,
    OrgRecordStatus,
)
from app.org_structure.repository import DepartmentRepository


class DepartmentService:
    """Orchestrates department management, employee assignments, and leadership assignments."""

    not_found_message = "Department not found."

    def __init__(
        self,
        repository: DepartmentRepository,
        assignment_repository: EmployeeDepartmentAssignmentRepository,
        leadership_repository: DepartmentLeadershipAssignmentRepository,
        employee_repository: EmployeeRepository,
    ) -> None:
        """Bind this service to its repositories."""
        self.repository = repository
        self.assignment_repository = assignment_repository
        self.leadership_repository = leadership_repository
        self.employee_repository = employee_repository

    # --- Department CRUD -----------------------------------------------------------
    async def get_by_id_or_raise(self, department_id: uuid.UUID) -> Department:
        """Fetch a department by ID or raise :class:`NotFoundException`."""
        department = await self.repository.get_by_id(department_id)
        if department is None:
            raise NotFoundException(self.not_found_message)
        return department

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Department], int]:
        """Return a page of departments matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all(self) -> list[Department]:
        """Return every department (for dropdowns and the department tree)."""
        return await self.repository.list_all()

    async def create(self, **field_values: Any) -> Department:
        """Create a new department, validating name uniqueness and parent-department existence."""
        name = field_values.get("name")
        if not name or not str(name).strip():
            raise ConflictException("Department name is required.")
        if await self.repository.name_exists(name):
            raise ConflictException(f"Department name {name!r} is already in use.")

        parent_id = field_values.get("parent_department_id")
        if parent_id is not None:
            await self.get_by_id_or_raise(parent_id)  # 404s cleanly if the parent doesn't exist

        return await self.repository.create(**field_values)

    async def update(self, department_id: uuid.UUID, **field_values: Any) -> Department:
        """Update a department, validating name uniqueness and preventing parent-department cycles."""
        department = await self.get_by_id_or_raise(department_id)

        name = field_values.get("name")
        if name and await self.repository.name_exists(name, exclude_id=department_id):
            raise ConflictException(f"Department name {name!r} is already in use.")

        parent_id = field_values.get("parent_department_id")
        if parent_id is not None:
            await self.get_by_id_or_raise(parent_id)
            if await self.repository.would_create_cycle(department_id, parent_id):
                raise ConflictException("This would create a circular department hierarchy.")

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(department, **changes)
        return department

    async def archive(self, department_id: uuid.UUID) -> Department:
        """
        Archive a department (Part 15): safe only if it has no active employee
        or leadership assignments, so nothing is silently orphaned.
        """
        department = await self.get_by_id_or_raise(department_id)
        active_assignments = await self.assignment_repository.list_for_department(department_id, active_only=True)
        if active_assignments:
            raise ConflictException(
                f"Cannot archive: {len(active_assignments)} employee(s) are still actively assigned to this department."
            )
        active_leadership = await self.leadership_repository.list_for_department(department_id, active_only=True)
        if active_leadership:
            raise ConflictException(
                f"Cannot archive: {len(active_leadership)} active leadership assignment(s) still reference this department."
            )
        await self.repository.update(department, status=OrgRecordStatus.ARCHIVED)
        return department

    async def activate(self, department_id: uuid.UUID) -> Department:
        """Set a department's status to ACTIVE (matches the standard MasterPage activate/deactivate contract)."""
        department = await self.get_by_id_or_raise(department_id)
        await self.repository.update(department, status=OrgRecordStatus.ACTIVE)
        return department

    async def deactivate(self, department_id: uuid.UUID) -> Department:
        """Set a department's status to INACTIVE (a lighter-weight toggle than :meth:`archive`; does not require an empty roster)."""
        department = await self.get_by_id_or_raise(department_id)
        await self.repository.update(department, status=OrgRecordStatus.INACTIVE)
        return department

    async def delete(self, department_id: uuid.UUID) -> None:
        """Soft-delete a department, refusing if it has any active assignment (Part 15/16)."""
        department = await self.get_by_id_or_raise(department_id)
        active_assignments = await self.assignment_repository.list_for_department(department_id, active_only=True)
        active_leadership = await self.leadership_repository.list_for_department(department_id, active_only=True)
        if active_assignments or active_leadership:
            raise ConflictException(
                "Cannot delete a department with active employee or leadership assignments. Archive it instead."
            )
        await self.repository.delete(department)

    # --- Employee <-> Department assignments (Part 2) ------------------------------
    async def list_department_roster(self, department_id: uuid.UUID) -> list[EmployeeDepartmentAssignment]:
        """List every active employee assignment for a department."""
        await self.get_by_id_or_raise(department_id)
        return await self.assignment_repository.list_for_department(department_id, active_only=True)

    async def list_employee_departments(self, employee_id: uuid.UUID) -> list[EmployeeDepartmentAssignment]:
        """List every department assignment held by an employee."""
        await self.employee_repository.get_by_id(employee_id) or self._raise_employee_not_found()
        return await self.assignment_repository.list_for_employee(employee_id)

    def _raise_employee_not_found(self) -> None:
        raise NotFoundException("Employee not found.")

    async def assign_employee(
        self,
        *,
        employee_id: uuid.UUID,
        department_id: uuid.UUID,
        assignment_type: DepartmentAssignmentType = DepartmentAssignmentType.PRIMARY,
        is_primary: bool = False,
        effective_from=None,
        effective_to=None,
    ) -> EmployeeDepartmentAssignment:
        """
        Assign an employee to a department (Part 2). An employee may hold any
        number of these simultaneously across different departments/types --
        the only restriction is no exact duplicate
        (employee, department, assignment_type) triple (Part 16).
        """
        employee = await self.employee_repository.get_by_id(employee_id)
        if employee is None:
            raise NotFoundException("Employee not found.")
        await self.get_by_id_or_raise(department_id)

        existing = await self.assignment_repository.get_exact(employee_id, department_id, assignment_type)
        if existing is not None and existing.status == OrgRecordStatus.ACTIVE:
            raise ConflictException(
                f"This employee already has an active {assignment_type.value} assignment to this department."
            )

        if is_primary:
            # Part 16: "Ensure only one primary active assignment when required."
            await self.assignment_repository.clear_primary_flag(employee_id)

        if existing is not None:
            # Reactivate a previously-ended assignment of the same shape rather
            # than creating a duplicate row for the exact same triple.
            await self.assignment_repository.update(
                existing, status=OrgRecordStatus.ACTIVE, is_primary=is_primary,
                effective_from=effective_from, effective_to=effective_to,
            )
            return existing

        return await self.assignment_repository.create(
            employee_id=employee_id,
            department_id=department_id,
            assignment_type=assignment_type,
            is_primary=is_primary,
            effective_from=effective_from,
            effective_to=effective_to,
            status=OrgRecordStatus.ACTIVE,
        )

    async def remove_employee_assignment(self, assignment_id: uuid.UUID) -> None:
        """End an employee's department assignment (soft: marks INACTIVE, preserving history per Part 14)."""
        assignment = await self.assignment_repository.get_by_id(assignment_id)
        if assignment is None:
            raise NotFoundException("Department assignment not found.")
        await self.assignment_repository.update(assignment, status=OrgRecordStatus.INACTIVE)

    # --- Department Leadership (Part 4) ---------------------------------------------
    async def list_leadership(self, department_id: uuid.UUID) -> list[DepartmentLeadershipAssignment]:
        """List every active leadership assignment for a department."""
        await self.get_by_id_or_raise(department_id)
        return await self.leadership_repository.list_for_department(department_id, active_only=True)

    async def list_employee_leadership(self, employee_id: uuid.UUID) -> list[DepartmentLeadershipAssignment]:
        """List every department an employee leads/manages, in any capacity."""
        return await self.leadership_repository.list_for_employee(employee_id, active_only=True)

    async def assign_leadership(
        self,
        *,
        department_id: uuid.UUID,
        employee_id: uuid.UUID,
        leadership_type: LeadershipType = LeadershipType.PRIMARY_MANAGER,
        is_primary: bool = False,
        enforce_single_primary_manager: bool = True,
        effective_from=None,
        effective_to=None,
    ) -> DepartmentLeadershipAssignment:
        """
        Assign an employee a leadership role over a department (Part 4). The
        same employee may lead several departments -- this only rejects an
        exact duplicate (department, employee, leadership_type) triple.

        ``enforce_single_primary_manager`` implements the brief's
        configurable "one active primary manager per department, if the
        business rule requires it" (Part 4/16) -- callers that want several
        co-equal PRIMARY_MANAGERs on one department can pass ``False``.
        """
        await self.get_by_id_or_raise(department_id)
        employee = await self.employee_repository.get_by_id(employee_id)
        if employee is None:
            raise NotFoundException("Employee not found.")

        existing = await self.leadership_repository.get_exact(department_id, employee_id, leadership_type)
        if existing is not None and existing.status == OrgRecordStatus.ACTIVE:
            raise ConflictException(
                f"This employee already holds an active {leadership_type.value} assignment on this department."
            )

        if enforce_single_primary_manager and leadership_type == LeadershipType.PRIMARY_MANAGER:
            current_primaries = await self.leadership_repository.get_active_by_type(
                department_id, LeadershipType.PRIMARY_MANAGER
            )
            if current_primaries:
                raise ConflictException(
                    "This department already has an active Primary Manager. Remove the existing "
                    "assignment first, or use ASSISTANT_MANAGER/ACTING_MANAGER instead."
                )

        if existing is not None:
            await self.leadership_repository.update(
                existing, status=OrgRecordStatus.ACTIVE, is_primary=is_primary,
                effective_from=effective_from, effective_to=effective_to,
            )
            return existing

        return await self.leadership_repository.create(
            department_id=department_id,
            employee_id=employee_id,
            leadership_type=leadership_type,
            is_primary=is_primary,
            effective_from=effective_from,
            effective_to=effective_to,
            status=OrgRecordStatus.ACTIVE,
        )

    async def remove_leadership(self, leadership_id: uuid.UUID) -> None:
        """End a department leadership assignment (soft: marks INACTIVE)."""
        leadership = await self.leadership_repository.get_by_id(leadership_id)
        if leadership is None:
            raise NotFoundException("Leadership assignment not found.")
        await self.leadership_repository.update(leadership, status=OrgRecordStatus.INACTIVE)
