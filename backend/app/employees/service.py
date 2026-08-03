"""
Employee Service.

Business logic for employee profile management: auto-generated employee
codes, uniqueness validation (code/email/phone), cross-module existence
checks (department/designation must exist), circular-manager-assignment
prevention, user linking, and the dedicated transfer/change-designation/
assign-manager/deactivate/reactivate actions called out in the Phase 6
spec.

NOT payroll, attendance, or leave -- this service only ever touches the
``employees`` table's profile columns.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.departments.repository import DepartmentRepository
from app.designations.repository import DesignationRepository
from app.employees.models import Employee, EmploymentStatus
from app.employees.repository import EmployeeRepository
from app.users.repository import UserRepository

_EMPLOYEE_CODE_PREFIX = "EMP"
_EMPLOYEE_CODE_WIDTH = 5
_MAX_CODE_GENERATION_ATTEMPTS = 5


class EmployeeService:
    """Orchestrates employee profile management on top of :class:`EmployeeRepository`."""

    not_found_message = "Employee not found."

    def __init__(
        self,
        repository: EmployeeRepository,
        department_repository: DepartmentRepository,
        designation_repository: DesignationRepository,
        user_repository: UserRepository,
        session: AsyncSession,
        cache_manager: CacheManager,
    ) -> None:
        """Bind this service to its repository and the other repositories it validates against."""
        self.repository = repository
        self.department_repository = department_repository
        self.designation_repository = designation_repository
        self.user_repository = user_repository
        self.session = session
        self.cache_manager = cache_manager

    # ------------------------------------------------------------------
    # Lookups / listing
    # ------------------------------------------------------------------

    async def get_by_id_or_raise(self, employee_id: uuid.UUID) -> Employee:
        """Fetch an employee by ID or raise :class:`NotFoundException`."""
        employee = await self.repository.get_by_id(employee_id)
        if employee is None:
            raise NotFoundException(self.not_found_message)
        return employee

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Employee], int]:
        """Return a page of employees matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def get_enrichment(self, employee: Employee) -> dict[str, str | None]:
        """Resolve department/designation/manager display names for the employee-detail view."""
        department_name = None
        designation_title = None
        manager_name = None
        if employee.department_id:
            department = await self.department_repository.get_by_id(employee.department_id)
            department_name = department.name if department else None
        if employee.designation_id:
            designation = await self.designation_repository.get_by_id(employee.designation_id)
            designation_title = designation.title if designation else None
        if employee.manager_id:
            manager = await self.repository.get_by_id(employee.manager_id)
            manager_name = manager.display_name if manager else None
        return {
            "department_name": department_name,
            "designation_title": designation_title,
            "manager_name": manager_name,
        }

    # ------------------------------------------------------------------
    # Cross-module / uniqueness validation helpers
    # ------------------------------------------------------------------

    async def _validate_department(self, department_id: uuid.UUID | None) -> None:
        """Ensure the referenced department exists."""
        if department_id is None:
            return
        department = await self.department_repository.get_by_id(department_id)
        if department is None:
            raise BadRequestException("The specified department does not exist.")

    async def _validate_designation(self, designation_id: uuid.UUID | None) -> None:
        """Ensure the referenced designation exists."""
        if designation_id is None:
            return
        designation = await self.designation_repository.get_by_id(designation_id)
        if designation is None:
            raise BadRequestException("The specified designation does not exist.")

    async def _validate_manager(self, employee_id: uuid.UUID | None, manager_id: uuid.UUID | None) -> None:
        """Ensure the referenced manager exists, is not the employee themself, and introduces no cycle."""
        if manager_id is None:
            return
        if employee_id is not None and manager_id == employee_id:
            raise BadRequestException("An employee cannot be their own manager.")
        manager = await self.repository.get_by_id(manager_id)
        if manager is None:
            raise BadRequestException("The specified manager does not exist.")
        if employee_id is None:
            return
        # If `employee_id` is already an ancestor of `manager_id`, assigning
        # `manager_id` as the employee's manager would create a reporting cycle.
        manager_chain = await self.repository.get_manager_chain_ids(manager_id)
        if employee_id in manager_chain:
            raise ConflictException("This manager assignment would create a circular reporting relationship.")

    async def _validate_uniqueness(
        self, *, email: str | None, phone: str | None, exclude_id: uuid.UUID | None
    ) -> None:
        """Ensure email/phone don't collide with another employee."""
        if email and await self.repository.email_exists(email, exclude_id=exclude_id):
            raise ConflictException(f"An employee with email {email!r} already exists.")
        if phone and await self.repository.phone_exists(phone, exclude_id=exclude_id):
            raise ConflictException(f"An employee with phone {phone!r} already exists.")

    async def _validate_user_link(self, user_id: uuid.UUID | None, *, exclude_id: uuid.UUID | None) -> None:
        """Ensure the user account exists and isn't already linked to a different employee."""
        if user_id is None:
            return
        user = await self.user_repository.get_by_id(user_id)
        if user is None:
            raise BadRequestException("The specified user account does not exist.")
        if await self.repository.user_id_linked(user_id, exclude_id=exclude_id):
            raise ConflictException("That user account is already linked to another employee.")

    async def _generate_employee_code(self) -> str:
        """Generate the next sequential employee code, e.g. ``EMP00001``."""
        next_number = await self.repository.next_sequence_number()
        for _ in range(_MAX_CODE_GENERATION_ATTEMPTS):
            candidate = f"{_EMPLOYEE_CODE_PREFIX}{next_number:0{_EMPLOYEE_CODE_WIDTH}d}"
            if not await self.repository.employee_code_exists(candidate):
                return candidate
            next_number += 1
        raise ConflictException("Could not generate a unique employee code. Please try again.")

    # ------------------------------------------------------------------
    # Create / Update
    # ------------------------------------------------------------------

    async def create(self, *, created_by: uuid.UUID, **field_values: Any) -> Employee:
        """Create a new employee profile with an auto-generated employee code."""
        email = field_values.get("email")
        phone = field_values.get("phone")
        department_id = field_values.get("department_id")
        designation_id = field_values.get("designation_id")
        manager_id = field_values.get("manager_id")
        user_id = field_values.get("user_id")

        await self._validate_uniqueness(email=email, phone=phone, exclude_id=None)
        await self._validate_department(department_id)
        await self._validate_designation(designation_id)
        await self._validate_manager(None, manager_id)
        await self._validate_user_link(user_id, exclude_id=None)

        employee_code = await self._generate_employee_code()

        try:
            employee = await self.repository.create(
                employee_code=employee_code,
                employment_status=EmploymentStatus.ACTIVE,
                created_by=created_by,
                updated_by=created_by,
                **field_values,
            )
        except IntegrityError as exc:
            await self.session.rollback()
            raise ConflictException(
                "Could not create employee: a unique field (code, email, or phone) is already in use."
            ) from exc
        return employee

    async def update(self, employee_id: uuid.UUID, *, updated_by: uuid.UUID, **field_values: Any) -> Employee:
        """Update an employee's profile fields (not department/designation/manager/status)."""
        employee = await self.get_by_id_or_raise(employee_id)
        email = field_values.get("email")
        phone = field_values.get("phone")
        await self._validate_uniqueness(email=email, phone=phone, exclude_id=employee_id)

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            changes["updated_by"] = updated_by
            try:
                await self.repository.update(employee, **changes)
            except IntegrityError as exc:
                await self.session.rollback()
                raise ConflictException(
                    "Could not update employee: the email or phone is already in use."
                ) from exc
        return employee

    # ------------------------------------------------------------------
    # Dedicated actions
    # ------------------------------------------------------------------

    async def transfer_department(
        self, employee_id: uuid.UUID, department_id: uuid.UUID, *, updated_by: uuid.UUID
    ) -> Employee:
        """Move an employee to a different department."""
        employee = await self.get_by_id_or_raise(employee_id)
        await self._validate_department(department_id)
        await self.repository.update(employee, department_id=department_id, updated_by=updated_by)
        return employee

    async def change_designation(
        self, employee_id: uuid.UUID, designation_id: uuid.UUID, *, updated_by: uuid.UUID
    ) -> Employee:
        """Change an employee's designation."""
        employee = await self.get_by_id_or_raise(employee_id)
        await self._validate_designation(designation_id)
        await self.repository.update(employee, designation_id=designation_id, updated_by=updated_by)
        return employee

    async def assign_manager(
        self, employee_id: uuid.UUID, manager_id: uuid.UUID | None, *, updated_by: uuid.UUID
    ) -> Employee:
        """Assign (or clear, with ``manager_id=None``) an employee's manager."""
        employee = await self.get_by_id_or_raise(employee_id)
        await self._validate_manager(employee_id, manager_id)
        await self.repository.update(employee, manager_id=manager_id, updated_by=updated_by)
        return employee

    async def link_user(self, employee_id: uuid.UUID, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> Employee:
        """Link an employee profile to an existing user account."""
        employee = await self.get_by_id_or_raise(employee_id)
        await self._validate_user_link(user_id, exclude_id=employee_id)
        await self.repository.update(employee, user_id=user_id, updated_by=updated_by)
        return employee

    async def deactivate(self, employee_id: uuid.UUID, *, updated_by: uuid.UUID) -> Employee:
        """Deactivate an employee (sets ``employment_status`` to ``INACTIVE``)."""
        employee = await self.get_by_id_or_raise(employee_id)
        await self.repository.update(
            employee, employment_status=EmploymentStatus.INACTIVE, updated_by=updated_by
        )
        return employee

    async def reactivate(self, employee_id: uuid.UUID, *, updated_by: uuid.UUID) -> Employee:
        """Reactivate a previously deactivated employee (sets ``employment_status`` back to ``ACTIVE``)."""
        employee = await self.get_by_id_or_raise(employee_id)
        await self.repository.update(
            employee, employment_status=EmploymentStatus.ACTIVE, updated_by=updated_by
        )
        return employee

    async def delete(self, employee_id: uuid.UUID) -> None:
        """Soft-delete an employee profile."""
        employee = await self.get_by_id_or_raise(employee_id)
        await self.repository.delete(employee)
