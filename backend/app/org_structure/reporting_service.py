"""
Reporting Service.

Owns the entire employee-to-employee reporting hierarchy: creating/
changing/removing reporting relationships, and the org chart data. This
is the SINGLE place circular-reporting prevention is enforced (Part 7 of
the upgrade brief) -- no other module writes to
``employee_reporting_relationships`` directly, so there is exactly one
code path to get this right, not several that could drift out of sync.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.org_structure.assignments_repository import EmployeeReportingRelationshipRepository
from app.org_structure.models import (
    EmployeeReportingRelationship,
    OrgRecordStatus,
    ReportingRelationshipType,
)
from app.users.repository import UserRepository


class ReportingService:
    """Orchestrates the employee reporting hierarchy, with mandatory cycle prevention."""

    not_found_message = "Reporting relationship not found."

    def __init__(self, repository: EmployeeReportingRelationshipRepository, employee_repository: UserRepository) -> None:
        """
        Bind this service to its repositories.

        ``employee_repository`` is a :class:`UserRepository` (Employee was
        merged into User -- see ``app.users.models.User`` docstring).
        """
        self.repository = repository
        self.employee_repository = employee_repository

    async def list_direct_reports(self, manager_employee_id: uuid.UUID) -> list[EmployeeReportingRelationship]:
        """List everyone who currently reports (any active relationship type) to this employee."""
        return await self.repository.list_direct_reports(manager_employee_id)

    async def list_managers(self, employee_id: uuid.UUID) -> list[EmployeeReportingRelationship]:
        """List every manager this employee currently reports to (across relationship types/departments)."""
        return await self.repository.list_for_employee(employee_id, active_only=True)

    async def get_org_chart_edges(self) -> list[EmployeeReportingRelationship]:
        """Return every active PRIMARY_REPORTING relationship -- the edge set the org chart is built from (Part 18)."""
        return await self.repository.list_all_active_primary()

    async def create_relationship(
        self,
        *,
        employee_id: uuid.UUID,
        manager_employee_id: uuid.UUID,
        relationship_type: ReportingRelationshipType = ReportingRelationshipType.PRIMARY_REPORTING,
        department_id: uuid.UUID | None = None,
        is_primary: bool = False,
        effective_from=None,
        effective_to=None,
    ) -> EmployeeReportingRelationship:
        """
        Create a reporting relationship, with mandatory validation (Part 7):

        1. Employee and manager must not be the same person.
        2. The proposed manager must not already be (directly or
           transitively) a report of the employee -- appointing them would
           close a loop somewhere in the graph.
        3. No exact duplicate (employee, manager, type, department) row.

        Both checks run at the backend/service layer unconditionally --
        never only in the frontend -- exactly as the brief requires ("This
        validation must exist at the backend level, not only frontend").
        """
        if employee_id == manager_employee_id:
            raise ConflictException("An employee cannot report to themselves.")

        employee = await self.employee_repository.get_by_id(employee_id)
        if employee is None:
            raise NotFoundException("Employee not found.")
        manager = await self.employee_repository.get_by_id(manager_employee_id)
        if manager is None:
            raise NotFoundException("Manager (employee) not found.")

        if await self.repository.would_create_cycle(employee_id, manager_employee_id):
            raise ConflictException(
                "This reporting assignment would create a circular reporting relationship "
                f"({manager.full_name} is already, directly or indirectly, a report of {employee.full_name})."
            )

        existing = await self.repository.get_exact(employee_id, manager_employee_id, relationship_type, department_id)
        if existing is not None and existing.status == OrgRecordStatus.ACTIVE:
            raise ConflictException("This exact reporting relationship already exists and is active.")

        if is_primary and relationship_type == ReportingRelationshipType.PRIMARY_REPORTING:
            # An employee may have several reporting lines (functional/project/
            # dotted-line), but only one PRIMARY reporting line marked as such.
            current_primary = await self.repository.get_active_primary_manager(employee_id)
            if current_primary is not None and (
                current_primary.manager_employee_id != manager_employee_id
                or current_primary.department_id != department_id
            ):
                raise ConflictException(
                    "This employee already has a different active Primary Reporting manager. "
                    "Remove or change that relationship first."
                )

        if existing is not None:
            await self.repository.update(
                existing, status=OrgRecordStatus.ACTIVE, is_primary=is_primary,
                effective_from=effective_from, effective_to=effective_to,
            )
            return existing

        return await self.repository.create(
            employee_id=employee_id,
            manager_employee_id=manager_employee_id,
            relationship_type=relationship_type,
            department_id=department_id,
            is_primary=is_primary,
            effective_from=effective_from,
            effective_to=effective_to,
            status=OrgRecordStatus.ACTIVE,
        )

    async def remove_relationship(self, relationship_id: uuid.UUID) -> None:
        """End a reporting relationship (soft: marks INACTIVE, preserving history per Part 14)."""
        relationship = await self.repository.get_by_id(relationship_id)
        if relationship is None:
            raise NotFoundException(self.not_found_message)
        await self.repository.update(relationship, status=OrgRecordStatus.INACTIVE)

    async def set_primary_manager(
        self, employee_id: uuid.UUID, manager_employee_id: uuid.UUID
    ) -> EmployeeReportingRelationship:
        """
        Set (or move) an employee's PRIMARY_REPORTING manager in one step --
        used by the drag-and-drop organization chart: dropping a person's
        card onto a new manager's card calls this once, rather than the
        frontend having to orchestrate "remove old relationship, then
        create new one" as two separate calls (which would leave the chart
        briefly inconsistent, or fail halfway, if done client-side).

        Any existing active PRIMARY_REPORTING relationship for this
        employee (in the unscoped, no-department case the chart uses) is
        deactivated first, then the new one is created -- with the same
        mandatory self-report/circular-reporting checks as
        :meth:`create_relationship`, so a chart drag can never bypass them.
        """
        current_primary = await self.repository.get_active_primary_manager(employee_id)
        if current_primary is not None and current_primary.manager_employee_id == manager_employee_id:
            return current_primary  # no-op: dropped onto the same manager they already have

        if current_primary is not None:
            await self.repository.update(current_primary, status=OrgRecordStatus.INACTIVE)

        return await self.create_relationship(
            employee_id=employee_id,
            manager_employee_id=manager_employee_id,
            relationship_type=ReportingRelationshipType.PRIMARY_REPORTING,
            is_primary=True,
        )

    async def check_safe_to_deactivate(self, employee_id: uuid.UUID) -> list[EmployeeReportingRelationship]:
        """
        Return this employee's active direct reports (Part 15: "Before
        deactivating an Employee who manages others: find active direct
        reports; require reassignment or another safe resolution; do not
        silently orphan reporting relationships"). An empty list means it's
        safe to deactivate with respect to reporting; a non-empty list means
        the caller must reassign those reports first.
        """
        return await self.repository.list_direct_reports(employee_id, active_only=True)

    async def reassign_direct_reports(
        self, *, from_manager_employee_id: uuid.UUID, to_manager_employee_id: uuid.UUID
    ) -> int:
        """
        Move every active direct report from one manager to another (used
        right before deactivating ``from_manager_employee_id``, so no
        reporting relationship is left dangling). Returns the number of
        relationships reassigned.
        """
        if from_manager_employee_id == to_manager_employee_id:
            raise ConflictException("Cannot reassign direct reports to the same manager being removed.")
        new_manager = await self.employee_repository.get_by_id(to_manager_employee_id)
        if new_manager is None:
            raise NotFoundException("The replacement manager (employee) was not found.")

        reports = await self.repository.list_direct_reports(from_manager_employee_id, active_only=True)
        reassigned = 0
        for relationship in reports:
            if await self.repository.would_create_cycle(relationship.employee_id, to_manager_employee_id):
                raise ConflictException(
                    f"Reassigning {relationship.employee_id} to the new manager would create a "
                    "circular reporting relationship. Resolve this report manually first."
                )
            existing_for_new_manager = await self.repository.get_exact(
                relationship.employee_id, to_manager_employee_id, relationship.relationship_type, relationship.department_id
            )
            if existing_for_new_manager is not None:
                # Already reports to the new manager under this exact shape --
                # just retire the old link, nothing new to create.
                await self.repository.update(relationship, status=OrgRecordStatus.INACTIVE)
            else:
                await self.repository.update(relationship, manager_employee_id=to_manager_employee_id)
            reassigned += 1
        return reassigned