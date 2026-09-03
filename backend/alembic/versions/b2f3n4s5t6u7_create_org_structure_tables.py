"""create org_structure tables (departments, positions, assignments)

Revision ID: b2f3n4s5t6u7
Revises: a1e2m3p4l5y6
Create Date: 2026-09-02 00:05:00.000000

Organization, Employee, Identity & Access Management upgrade -- Parts 2-8.

Adds six NEW, purely additive tables:

    departments
    positions
    employee_department_assignments
    employee_position_assignments
    department_leadership_assignments
    employee_reporting_relationships

None of these touch ``users``, ``roles``, ``permissions``,
``role_permissions``, ``user_roles``, or ``user_permissions`` in any way --
the existing RBAC engine (software access) and this new organizational
layer are completely independent schemas, by design (see
``app/org_structure/models.py`` for the full rationale, including why this
is NOT a revival of the old ``app.departments``/``app.designations``
modules removed in migration
``e7b8c9d0e1f2_remove_teams_departments_designations.py``).
"""
from alembic import op
import sqlalchemy as sa
import app.database.base


# revision identifiers, used by Alembic.
revision = 'b2f3n4s5t6u7'
down_revision = 'a1e2m3p4l5y6'

branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- departments ---------------------------------------------------------------
    op.create_table(
        'departments',
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('code', sa.String(length=50), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('parent_department_id', app.database.base.GUID(), nullable=True),
        sa.Column('status', sa.Enum('ACTIVE', 'INACTIVE', 'ARCHIVED', name='department_status', native_enum=False, length=20), nullable=False, server_default='ACTIVE'),
        sa.ForeignKeyConstraint(['parent_department_id'], ['departments.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
        sa.UniqueConstraint('code'),
    )
    op.create_index('ix_departments_name', 'departments', ['name'], unique=True)
    op.create_index('ix_departments_code', 'departments', ['code'], unique=True)
    op.create_index('ix_departments_parent_department_id', 'departments', ['parent_department_id'], unique=False)
    op.create_index('ix_departments_status', 'departments', ['status'], unique=False)

    # --- positions -------------------------------------------------------------------
    op.create_table(
        'positions',
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('name', sa.String(length=150), nullable=False),
        sa.Column('code', sa.String(length=50), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('status', sa.Enum('ACTIVE', 'INACTIVE', 'ARCHIVED', name='position_status', native_enum=False, length=20), nullable=False, server_default='ACTIVE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
        sa.UniqueConstraint('code'),
    )
    op.create_index('ix_positions_name', 'positions', ['name'], unique=True)
    op.create_index('ix_positions_code', 'positions', ['code'], unique=True)
    op.create_index('ix_positions_status', 'positions', ['status'], unique=False)

    # --- employee_department_assignments ----------------------------------------------
    op.create_table(
        'employee_department_assignments',
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('employee_id', app.database.base.GUID(), nullable=False),
        sa.Column('department_id', app.database.base.GUID(), nullable=False),
        sa.Column('assignment_type', sa.Enum('PRIMARY', 'SECONDARY', 'TEMPORARY', 'PROJECT', 'ACTING', name='dept_assignment_type', native_enum=False, length=20), nullable=False, server_default='PRIMARY'),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('effective_from', sa.Date(), nullable=True),
        sa.Column('effective_to', sa.Date(), nullable=True),
        sa.Column('status', sa.Enum('ACTIVE', 'INACTIVE', 'ARCHIVED', name='dept_assignment_status', native_enum=False, length=20), nullable=False, server_default='ACTIVE'),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('employee_id', 'department_id', 'assignment_type', name='uq_emp_dept_assignment_type'),
    )
    op.create_index('ix_employee_department_assignments_employee_id', 'employee_department_assignments', ['employee_id'], unique=False)
    op.create_index('ix_employee_department_assignments_department_id', 'employee_department_assignments', ['department_id'], unique=False)
    op.create_index('ix_employee_department_assignments_status', 'employee_department_assignments', ['status'], unique=False)

    # --- employee_position_assignments ------------------------------------------------
    op.create_table(
        'employee_position_assignments',
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('employee_id', app.database.base.GUID(), nullable=False),
        sa.Column('position_id', app.database.base.GUID(), nullable=False),
        sa.Column('department_id', app.database.base.GUID(), nullable=True),
        sa.Column('assignment_type', sa.Enum('PRIMARY', 'SECONDARY', 'ACTING', 'TEMPORARY', name='position_assignment_type', native_enum=False, length=20), nullable=False, server_default='PRIMARY'),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('effective_from', sa.Date(), nullable=True),
        sa.Column('effective_to', sa.Date(), nullable=True),
        sa.Column('status', sa.Enum('ACTIVE', 'INACTIVE', 'ARCHIVED', name='position_assignment_status', native_enum=False, length=20), nullable=False, server_default='ACTIVE'),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['position_id'], ['positions.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('employee_id', 'position_id', 'assignment_type', name='uq_emp_position_assignment_type'),
    )
    op.create_index('ix_employee_position_assignments_employee_id', 'employee_position_assignments', ['employee_id'], unique=False)
    op.create_index('ix_employee_position_assignments_position_id', 'employee_position_assignments', ['position_id'], unique=False)
    op.create_index('ix_employee_position_assignments_department_id', 'employee_position_assignments', ['department_id'], unique=False)
    op.create_index('ix_employee_position_assignments_status', 'employee_position_assignments', ['status'], unique=False)

    # --- department_leadership_assignments --------------------------------------------
    op.create_table(
        'department_leadership_assignments',
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('department_id', app.database.base.GUID(), nullable=False),
        sa.Column('employee_id', app.database.base.GUID(), nullable=False),
        sa.Column('leadership_type', sa.Enum('DEPARTMENT_HEAD', 'PRIMARY_MANAGER', 'ASSISTANT_MANAGER', 'ACTING_MANAGER', name='leadership_type', native_enum=False, length=30), nullable=False, server_default='PRIMARY_MANAGER'),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('effective_from', sa.Date(), nullable=True),
        sa.Column('effective_to', sa.Date(), nullable=True),
        sa.Column('status', sa.Enum('ACTIVE', 'INACTIVE', 'ARCHIVED', name='leadership_assignment_status', native_enum=False, length=20), nullable=False, server_default='ACTIVE'),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('department_id', 'employee_id', 'leadership_type', name='uq_dept_leadership_type'),
    )
    op.create_index('ix_department_leadership_assignments_department_id', 'department_leadership_assignments', ['department_id'], unique=False)
    op.create_index('ix_department_leadership_assignments_employee_id', 'department_leadership_assignments', ['employee_id'], unique=False)
    op.create_index('ix_department_leadership_assignments_status', 'department_leadership_assignments', ['status'], unique=False)

    # --- employee_reporting_relationships ----------------------------------------------
    op.create_table(
        'employee_reporting_relationships',
        sa.Column('id', app.database.base.GUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('employee_id', app.database.base.GUID(), nullable=False),
        sa.Column('manager_employee_id', app.database.base.GUID(), nullable=False),
        sa.Column('relationship_type', sa.Enum('PRIMARY_REPORTING', 'FUNCTIONAL_REPORTING', 'PROJECT_REPORTING', 'DOTTED_LINE', 'TEMPORARY_REPORTING', name='reporting_relationship_type', native_enum=False, length=30), nullable=False, server_default='PRIMARY_REPORTING'),
        sa.Column('department_id', app.database.base.GUID(), nullable=True),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('effective_from', sa.Date(), nullable=True),
        sa.Column('effective_to', sa.Date(), nullable=True),
        sa.Column('status', sa.Enum('ACTIVE', 'INACTIVE', 'ARCHIVED', name='reporting_relationship_status', native_enum=False, length=20), nullable=False, server_default='ACTIVE'),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['manager_employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('employee_id', 'manager_employee_id', 'relationship_type', 'department_id', name='uq_reporting_relationship'),
    )
    op.create_index('ix_employee_reporting_relationships_employee_id', 'employee_reporting_relationships', ['employee_id'], unique=False)
    op.create_index('ix_employee_reporting_relationships_manager_employee_id', 'employee_reporting_relationships', ['manager_employee_id'], unique=False)
    op.create_index('ix_employee_reporting_relationships_department_id', 'employee_reporting_relationships', ['department_id'], unique=False)
    op.create_index('ix_employee_reporting_relationships_status', 'employee_reporting_relationships', ['status'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_employee_reporting_relationships_status', table_name='employee_reporting_relationships')
    op.drop_index('ix_employee_reporting_relationships_department_id', table_name='employee_reporting_relationships')
    op.drop_index('ix_employee_reporting_relationships_manager_employee_id', table_name='employee_reporting_relationships')
    op.drop_index('ix_employee_reporting_relationships_employee_id', table_name='employee_reporting_relationships')
    op.drop_table('employee_reporting_relationships')

    op.drop_index('ix_department_leadership_assignments_status', table_name='department_leadership_assignments')
    op.drop_index('ix_department_leadership_assignments_employee_id', table_name='department_leadership_assignments')
    op.drop_index('ix_department_leadership_assignments_department_id', table_name='department_leadership_assignments')
    op.drop_table('department_leadership_assignments')

    op.drop_index('ix_employee_position_assignments_status', table_name='employee_position_assignments')
    op.drop_index('ix_employee_position_assignments_department_id', table_name='employee_position_assignments')
    op.drop_index('ix_employee_position_assignments_position_id', table_name='employee_position_assignments')
    op.drop_index('ix_employee_position_assignments_employee_id', table_name='employee_position_assignments')
    op.drop_table('employee_position_assignments')

    op.drop_index('ix_employee_department_assignments_status', table_name='employee_department_assignments')
    op.drop_index('ix_employee_department_assignments_department_id', table_name='employee_department_assignments')
    op.drop_index('ix_employee_department_assignments_employee_id', table_name='employee_department_assignments')
    op.drop_table('employee_department_assignments')

    op.drop_index('ix_positions_status', table_name='positions')
    op.drop_index('ix_positions_code', table_name='positions')
    op.drop_index('ix_positions_name', table_name='positions')
    op.drop_table('positions')

    op.drop_index('ix_departments_status', table_name='departments')
    op.drop_index('ix_departments_parent_department_id', table_name='departments')
    op.drop_index('ix_departments_code', table_name='departments')
    op.drop_index('ix_departments_name', table_name='departments')
    op.drop_table('departments')
