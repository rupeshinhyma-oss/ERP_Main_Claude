"""
Organization Structure Repositories -- Assignment Tables.

Query-specific extensions for the three remaining many-to-many/relationship
tables: EmployeePositionAssignment, DepartmentLeadershipAssignment, and
EmployeeReportingRelationship. EmployeeDepartmentAssignment was merged into
``app.rbac.models.UserRole`` (Department/Role merge) -- see
``app.org_structure.models`` module docstring; its repository logic no
longer exists here, superseded by ``app.rbac.repository.UserRoleRepository``.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.org_structure.models import (
    DepartmentLeadershipAssignment,
    EmployeePositionAssignment,
    EmployeeReportingRelationship,
    OrgRecordStatus,
)


class EmployeePositionAssignmentRepository(BaseRepository[EmployeePositionAssignment]):
    """Repository for employee <-> position assignment rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``EmployeePositionAssignment`` model."""
        super().__init__(session, EmployeePositionAssignment)

    async def count_for_positions(
        self, position_ids: list[uuid.UUID], *, active_only: bool = True
    ) -> dict[uuid.UUID, int]:
        """Return a mapping of position_id -> count of assignments."""
        if not position_ids:
            return {}
        stmt = (
            select(EmployeePositionAssignment.position_id, func.count(EmployeePositionAssignment.id))
            .where(EmployeePositionAssignment.position_id.in_(position_ids))
        )
        if active_only:
            stmt = stmt.where(EmployeePositionAssignment.status == OrgRecordStatus.ACTIVE)
        stmt = stmt.group_by(EmployeePositionAssignment.position_id)
        result = await self.session.execute(stmt)
        counts = {pos_id: cnt for pos_id, cnt in result.all()}
        return {pos_id: counts.get(pos_id, 0) for pos_id in position_ids}

    async def list_for_employee(self, employee_id: uuid.UUID, *, active_only: bool = False) -> list[EmployeePositionAssignment]:
        """List every position assignment for an employee."""
        stmt = select(EmployeePositionAssignment).where(EmployeePositionAssignment.employee_id == employee_id)
        if active_only:
            stmt = stmt.where(EmployeePositionAssignment.status == OrgRecordStatus.ACTIVE)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_for_position(self, position_id: uuid.UUID, *, active_only: bool = True) -> list[EmployeePositionAssignment]:
        """List every employee assignment for a position."""
        stmt = select(EmployeePositionAssignment).where(EmployeePositionAssignment.position_id == position_id)
        if active_only:
            stmt = stmt.where(EmployeePositionAssignment.status == OrgRecordStatus.ACTIVE)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_exact(
        self, employee_id: uuid.UUID, position_id: uuid.UUID, assignment_type
    ) -> EmployeePositionAssignment | None:
        """Fetch the exact (employee, position, assignment_type) row, if it exists."""
        stmt = select(EmployeePositionAssignment).where(
            EmployeePositionAssignment.employee_id == employee_id,
            EmployeePositionAssignment.position_id == position_id,
            EmployeePositionAssignment.assignment_type == assignment_type,
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def clear_primary_flag(self, employee_id: uuid.UUID) -> None:
        """Unset ``is_primary`` on every one of an employee's position assignments."""
        stmt = select(EmployeePositionAssignment).where(
            EmployeePositionAssignment.employee_id == employee_id,
            EmployeePositionAssignment.is_primary.is_(True),
        )
        result = await self.session.execute(stmt)
        for row in result.scalars().all():
            row.is_primary = False
        await self.session.flush()


class DepartmentLeadershipAssignmentRepository(BaseRepository[DepartmentLeadershipAssignment]):
    """Repository for department leadership assignment rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``DepartmentLeadershipAssignment`` model."""
        super().__init__(session, DepartmentLeadershipAssignment)

    async def list_for_department(self, department_id: uuid.UUID, *, active_only: bool = True) -> list[DepartmentLeadershipAssignment]:
        """List every leadership assignment for a department."""
        stmt = select(DepartmentLeadershipAssignment).where(DepartmentLeadershipAssignment.department_id == department_id)
        if active_only:
            stmt = stmt.where(DepartmentLeadershipAssignment.status == OrgRecordStatus.ACTIVE)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_for_employee(self, employee_id: uuid.UUID, *, active_only: bool = True) -> list[DepartmentLeadershipAssignment]:
        """List every department this employee leads/manages (any leadership type)."""
        stmt = select(DepartmentLeadershipAssignment).where(DepartmentLeadershipAssignment.employee_id == employee_id)
        if active_only:
            stmt = stmt.where(DepartmentLeadershipAssignment.status == OrgRecordStatus.ACTIVE)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_exact(
        self, department_id: uuid.UUID, employee_id: uuid.UUID, leadership_type
    ) -> DepartmentLeadershipAssignment | None:
        """Fetch the exact (department, employee, leadership_type) row, if it exists."""
        stmt = select(DepartmentLeadershipAssignment).where(
            DepartmentLeadershipAssignment.department_id == department_id,
            DepartmentLeadershipAssignment.employee_id == employee_id,
            DepartmentLeadershipAssignment.leadership_type == leadership_type,
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_active_by_type(self, department_id: uuid.UUID, leadership_type) -> list[DepartmentLeadershipAssignment]:
        """Fetch every active assignment of a given leadership type for a department (used to enforce 'one active primary manager' when configured)."""
        stmt = select(DepartmentLeadershipAssignment).where(
            DepartmentLeadershipAssignment.department_id == department_id,
            DepartmentLeadershipAssignment.leadership_type == leadership_type,
            DepartmentLeadershipAssignment.status == OrgRecordStatus.ACTIVE,
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class EmployeeReportingRelationshipRepository(BaseRepository[EmployeeReportingRelationship]):
    """Repository for employee-to-employee reporting relationship rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``EmployeeReportingRelationship`` model."""
        super().__init__(session, EmployeeReportingRelationship)

    async def list_direct_reports(self, manager_employee_id: uuid.UUID, *, active_only: bool = True) -> list[EmployeeReportingRelationship]:
        """List every relationship where this employee is the manager (their direct reports)."""
        stmt = select(EmployeeReportingRelationship).where(
            EmployeeReportingRelationship.manager_employee_id == manager_employee_id
        )
        if active_only:
            stmt = stmt.where(EmployeeReportingRelationship.status == OrgRecordStatus.ACTIVE)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_for_employee(self, employee_id: uuid.UUID, *, active_only: bool = False) -> list[EmployeeReportingRelationship]:
        """List every relationship where this employee is the report (who they report to)."""
        stmt = select(EmployeeReportingRelationship).where(EmployeeReportingRelationship.employee_id == employee_id)
        if active_only:
            stmt = stmt.where(EmployeeReportingRelationship.status == OrgRecordStatus.ACTIVE)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_exact(
        self, employee_id: uuid.UUID, manager_employee_id: uuid.UUID, relationship_type, department_id: uuid.UUID | None
    ) -> EmployeeReportingRelationship | None:
        """Fetch the exact (employee, manager, type, department) row, if it exists."""
        stmt = select(EmployeeReportingRelationship).where(
            EmployeeReportingRelationship.employee_id == employee_id,
            EmployeeReportingRelationship.manager_employee_id == manager_employee_id,
            EmployeeReportingRelationship.relationship_type == relationship_type,
            EmployeeReportingRelationship.department_id == department_id
            if department_id is not None
            else EmployeeReportingRelationship.department_id.is_(None),
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_active_primary_manager(self, employee_id: uuid.UUID) -> EmployeeReportingRelationship | None:
        """Fetch the employee's current active PRIMARY_REPORTING manager relationship, if any."""
        from app.org_structure.models import ReportingRelationshipType

        stmt = select(EmployeeReportingRelationship).where(
            EmployeeReportingRelationship.employee_id == employee_id,
            EmployeeReportingRelationship.relationship_type == ReportingRelationshipType.PRIMARY_REPORTING,
            EmployeeReportingRelationship.status == OrgRecordStatus.ACTIVE,
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all_active_primary(self) -> list[EmployeeReportingRelationship]:
        """List every active PRIMARY_REPORTING relationship in the system (the org chart's edge set)."""
        from app.org_structure.models import ReportingRelationshipType

        stmt = select(EmployeeReportingRelationship).where(
            EmployeeReportingRelationship.relationship_type == ReportingRelationshipType.PRIMARY_REPORTING,
            EmployeeReportingRelationship.status == OrgRecordStatus.ACTIVE,
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def would_create_cycle(self, employee_id: uuid.UUID, proposed_manager_id: uuid.UUID) -> bool:
        """
        Return True if making ``proposed_manager_id`` manage ``employee_id`` would
        create a cycle anywhere in the ACTIVE reporting graph (any relationship
        type -- a cycle is a cycle regardless of which specific line it forms
        across, since Part 7 requires this check unconditionally).

        Traverses upward from ``proposed_manager_id`` through the existing
        active "manager of my manager" chain: if ``employee_id`` is ever
        reached, appointing them as an (even indirect) manager of their own
        manager would close a loop, so the appointment is rejected.
        """
        if employee_id == proposed_manager_id:
            return True  # Part 7: A cannot report to A.

        visited: set[uuid.UUID] = set()
        frontier = [proposed_manager_id]
        while frontier:
            current_id = frontier.pop()
            if current_id in visited:
                continue
            visited.add(current_id)
            stmt = select(EmployeeReportingRelationship.manager_employee_id).where(
                EmployeeReportingRelationship.employee_id == current_id,
                EmployeeReportingRelationship.status == OrgRecordStatus.ACTIVE,
            )
            result = await self.session.execute(stmt)
            for (manager_id,) in result.all():
                if manager_id == employee_id:
                    return True
                if manager_id not in visited:
                    frontier.append(manager_id)
        return False