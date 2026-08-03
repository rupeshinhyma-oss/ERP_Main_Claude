"""
Employee Repository.

Query-specific extensions for ``employees``: uniqueness checks (code,
email, phone), employee-code generation, and manager-chain traversal (used
by the service layer to prevent circular manager assignments).
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.employees.models import Employee


class EmployeeRepository(BaseRepository[Employee]):
    """Repository for employee rows."""

    searchable_fields = ("employee_code", "display_name", "first_name", "last_name", "email", "phone")
    sortable_fields = (
        "employee_code",
        "display_name",
        "first_name",
        "last_name",
        "date_of_joining",
        "employment_status",
        "created_at",
        "updated_at",
    )
    filterable_fields = (
        "department_id",
        "designation_id",
        "manager_id",
        "employment_type",
        "employment_status",
    )

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Employee`` model."""
        super().__init__(session, Employee)

    async def get_by_email(self, email: str) -> Employee | None:
        """Fetch an employee by their exact email address (ignores soft-deleted rows)."""
        stmt = self._base_select().where(Employee.email == email)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def email_exists(self, email: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) employee already uses this email."""
        stmt = self._base_select().with_only_columns(Employee.id).where(Employee.email == email)
        if exclude_id is not None:
            stmt = stmt.where(Employee.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def phone_exists(self, phone: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) employee already uses this phone number."""
        stmt = self._base_select().with_only_columns(Employee.id).where(Employee.phone == phone)
        if exclude_id is not None:
            stmt = stmt.where(Employee.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def employee_code_exists(self, employee_code: str) -> bool:
        """Return True if this employee code is already in use (including soft-deleted rows, so codes never get reused)."""
        stmt = select(Employee.id).where(Employee.employee_code == employee_code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def next_sequence_number(self) -> int:
        """
        Return the next number to use when generating an ``employee_code``.

        Counts ALL rows (including soft-deleted ones) so a deactivated/
        deleted employee's code is never reissued to someone else.
        """
        stmt = select(func.count()).select_from(Employee)
        result = await self.session.execute(stmt)
        return int(result.scalar_one()) + 1

    async def get_by_user_id(self, user_id: uuid.UUID) -> Employee | None:
        """Fetch the employee profile linked to a given user account, if any."""
        stmt = self._base_select().where(Employee.user_id == user_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def user_id_linked(self, user_id: uuid.UUID, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if this user account is already linked to a (different) employee."""
        stmt = self._base_select().with_only_columns(Employee.id).where(Employee.user_id == user_id)
        if exclude_id is not None:
            stmt = stmt.where(Employee.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_manager_chain_ids(self, employee_id: uuid.UUID, *, max_depth: int = 50) -> set[uuid.UUID]:
        """
        Return the set of employee IDs reachable by walking UP the manager chain from ``employee_id``.

        Used to detect would-be cycles before assigning a manager: if the
        proposed manager is already in this set, assigning them would
        create a reporting loop. ``max_depth`` guards against pre-existing
        corrupt/cyclic data causing an unbounded walk.
        """
        chain: set[uuid.UUID] = set()
        current_id: uuid.UUID | None = employee_id
        for _ in range(max_depth):
            if current_id is None:
                break
            employee = await self.get_by_id(current_id)
            if employee is None or employee.manager_id is None:
                break
            if employee.manager_id in chain:
                break
            chain.add(employee.manager_id)
            current_id = employee.manager_id
        return chain
