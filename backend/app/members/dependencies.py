"""Team Member Dependencies. FastAPI DI wiring for the Teams 'Add Member' composed flow."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_auth_service
from app.auth.service import AuthService
from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.departments.repository import DepartmentRepository
from app.designations.repository import DesignationRepository
from app.employees.repository import EmployeeRepository
from app.employees.service import EmployeeService
from app.members.repository import MemberPasswordVaultRepository
from app.members.service import TeamMemberService
from app.rbac.repository import PermissionRepository, RoleRepository, UserRoleRepository
from app.rbac.service import RBACService
from app.users.repository import UserRepository
from app.users.service import UserService


def get_team_member_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
    auth_service: AuthService = Depends(get_auth_service),
) -> TeamMemberService:
    """Build a request-scoped :class:`TeamMemberService`, composing the existing User/Employee/RBAC services."""
    user_role_repository = UserRoleRepository(db)
    rbac_service = RBACService(
        role_repository=RoleRepository(db),
        permission_repository=PermissionRepository(db),
        user_role_repository=user_role_repository,
    )
    user_service = UserService(
        user_repository=UserRepository(db),
        user_role_repository=user_role_repository,
        rbac_service=rbac_service,
        auth_service=auth_service,
    )
    employee_service = EmployeeService(
        repository=EmployeeRepository(db),
        department_repository=DepartmentRepository(db),
        designation_repository=DesignationRepository(db),
        user_repository=UserRepository(db),
        session=db,
        cache_manager=cache_manager,
    )
    return TeamMemberService(
        user_service=user_service,
        employee_service=employee_service,
        rbac_service=rbac_service,
        department_repository=DepartmentRepository(db),
        designation_repository=DesignationRepository(db),
        password_vault_repository=MemberPasswordVaultRepository(db),
    )