"""merge department into role, employee department assignment into user_role

Revision ID: c3g4o5p6q7r8
Revises: b2f3n4s5t6u7
Create Date: 2026-09-02 12:00:00.000000

Organization, Employee, Identity & Access Management upgrade -- Merge phase, Part 1.

Business decision: "Departments" (real org units) and "Departments &
Permissions" (Role) were two separate screens/tables, which was confusing
to use day-to-day. This migration merges them into one: ``departments``
rows become ``roles`` rows (gaining ``code`` and ``parent_department_id``
columns), and ``employee_department_assignments`` rows become
``user_roles`` rows (gaining ``assignment_type``, ``is_primary``,
``effective_from``, ``effective_to``, ``status`` columns) -- but ONLY for
department assignments belonging to an employee who has a linked User
Account (``employees.user_id IS NOT NULL``), since ``user_roles`` is keyed
on ``user_id``, not ``employee_id``. Any department assignment belonging
to an employee with no login account cannot be represented as a
``user_role`` and is intentionally left un-migrated (see the NOTICE raised
at migration time and the upgrade report) -- this is a real, known
limitation of merging Department into a User-keyed table, and is resolved
in the next migration once Employee is merged into User (making
"employee with no user_id" not exist as a concept requiring translation
at all).

After copying data, ``employee_department_assignments`` and
``departments`` are dropped. ``app.org_structure`` no longer owns any
department-related tables after this migration.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
import app.database.base


# revision identifiers, used by Alembic.
revision = 'c3g4o5p6q7r8'
down_revision = 'b2f3n4s5t6u7'

branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    def _fk_constraint_name(table_name: str, column_name: str, target_table: str) -> str | None:
        """
        Look up the actual (Postgres-auto-generated) FK constraint name for
        a column pointing at a specific target table, rather than assuming
        the default `<table>_<column>_fkey` naming -- these tables were
        created without an explicit naming_convention on the metadata, so
        Postgres's default applies, but querying it directly is more
        robust than hardcoding a guess. Returns None if no such FK exists
        (a column can have zero or one FK per target table).
        """
        result = conn.execute(text(
            "SELECT tc.constraint_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema "
            "JOIN information_schema.constraint_column_usage ccu "
            "  ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema "
            "WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = :table_name "
            "  AND kcu.column_name = :column_name AND ccu.table_name = :target_table"
        ), {"table_name": table_name, "column_name": column_name, "target_table": target_table}).fetchone()
        return result[0] if result is not None else None

    # --- 1. Add the new columns to roles / user_roles (nullable-safe, no data loss) ---
    op.add_column('roles', sa.Column('code', sa.String(length=50), nullable=True))
    op.add_column('roles', sa.Column('parent_department_id', app.database.base.GUID(), nullable=True))
    op.create_unique_constraint('uq_roles_code', 'roles', ['code'])
    op.create_index('ix_roles_code', 'roles', ['code'], unique=False)
    op.create_index('ix_roles_parent_department_id', 'roles', ['parent_department_id'], unique=False)
    op.create_foreign_key(
        'fk_roles_parent_department_id', 'roles', 'roles',
        ['parent_department_id'], ['id'], ondelete='SET NULL',
    )

    op.add_column(
        'user_roles',
        sa.Column(
            'assignment_type',
            sa.Enum('PRIMARY', 'SECONDARY', 'TEMPORARY', 'PROJECT', 'ACTING',
                    name='role_assignment_type', native_enum=False, length=20),
            nullable=False, server_default='PRIMARY',
        ),
    )
    op.add_column('user_roles', sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('user_roles', sa.Column('effective_from', sa.Date(), nullable=True))
    op.add_column('user_roles', sa.Column('effective_to', sa.Date(), nullable=True))
    op.add_column(
        'user_roles',
        sa.Column(
            'status',
            sa.Enum('ACTIVE', 'INACTIVE', name='role_assignment_status', native_enum=False, length=20),
            nullable=False, server_default='ACTIVE',
        ),
    )
    op.create_index('ix_user_roles_status', 'user_roles', ['status'], unique=False)

    # --- 2. Copy departments -> roles ---------------------------------------------------
    # A Role.name must be globally unique, and a department's name might
    # already coincide with an existing Role's name (unlikely, but possible)
    # -- suffix on conflict rather than fail the whole migration.
    dept_rows = conn.execute(text(
        "SELECT id, name, code, description, parent_department_id, status, created_at, updated_at "
        "FROM departments WHERE deleted_at IS NULL"
    )).fetchall()

    dept_id_to_role_id: dict = {}
    for row in dept_rows:
        candidate_name = row.name
        suffix = 0
        while conn.execute(
            text("SELECT 1 FROM roles WHERE name = :name"), {"name": candidate_name}
        ).fetchone() is not None:
            suffix += 1
            candidate_name = f"{row.name} (Dept {suffix})"

        new_role_id = conn.execute(text(
            "INSERT INTO roles (id, name, description, is_system, code, parent_department_id, "
            "created_at, updated_at, version, deleted_at) "
            "VALUES (gen_random_uuid(), :name, :description, false, :code, NULL, "
            ":created_at, :updated_at, 1, NULL) RETURNING id"
        ), {
            "name": candidate_name,
            "description": row.description,
            "code": row.code,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }).fetchone()
        dept_id_to_role_id[str(row.id)] = str(new_role_id[0])

    # Second pass: now that every department has a role, wire up parent_department_id
    # (self-referential, so parents must exist before children can point at them --
    # done as a second pass since dict is now fully populated regardless of row order).
    for row in dept_rows:
        if row.parent_department_id is not None:
            parent_role_id = dept_id_to_role_id.get(str(row.parent_department_id))
            if parent_role_id:
                conn.execute(text(
                    "UPDATE roles SET parent_department_id = :parent_id WHERE id = :role_id"
                ), {"parent_id": parent_role_id, "role_id": dept_id_to_role_id[str(row.id)]})

    # --- 3. Copy employee_department_assignments -> user_roles (linked employees only) ---
    assignment_rows = conn.execute(text(
        "SELECT eda.employee_id, eda.department_id, eda.assignment_type, eda.is_primary, "
        "eda.effective_from, eda.effective_to, eda.status, eda.created_at, e.user_id "
        "FROM employee_department_assignments eda "
        "JOIN employees e ON e.id = eda.employee_id "
        "WHERE e.user_id IS NOT NULL"
    )).fetchall()

    skipped_no_login = conn.execute(text(
        "SELECT COUNT(*) FROM employee_department_assignments eda "
        "JOIN employees e ON e.id = eda.employee_id WHERE e.user_id IS NULL"
    )).scalar()

    for row in assignment_rows:
        role_id = dept_id_to_role_id.get(str(row.department_id))
        if not role_id:
            continue
        existing = conn.execute(text(
            "SELECT id FROM user_roles WHERE user_id = :user_id AND role_id = :role_id"
        ), {"user_id": str(row.user_id), "role_id": role_id}).fetchone()
        if existing:
            continue  # user already linked to this role/department another way -- don't duplicate
        conn.execute(text(
            "INSERT INTO user_roles (id, user_id, role_id, assigned_at, assigned_by, "
            "assignment_type, is_primary, effective_from, effective_to, status) "
            "VALUES (gen_random_uuid(), :user_id, :role_id, :assigned_at, NULL, "
            ":assignment_type, :is_primary, :effective_from, :effective_to, :status)"
        ), {
            "user_id": str(row.user_id),
            "role_id": role_id,
            "assigned_at": row.created_at,
            "assignment_type": row.assignment_type,
            "is_primary": row.is_primary,
            "effective_from": row.effective_from,
            "effective_to": row.effective_to,
            "status": row.status,
        })

    if skipped_no_login:
        print(
            f"NOTICE: {skipped_no_login} department assignment(s) belonged to employee(s) with "
            "no linked User Account and could NOT be migrated to user_roles (which is keyed on "
            "user_id). These employees' department placement is preserved in the original "
            "employees/employee_department_assignments data only until the next migration "
            "(Employee -> User merge) gives every employee record a user_id to migrate against."
        )

    # --- 4. Retarget department_id FKs on the three SURVIVING tables ------------------
    # employee_position_assignments, department_leadership_assignments, and
    # employee_reporting_relationships all have their own department_id ->
    # departments.id foreign key and are NOT being dropped in this migration
    # -- only employee_department_assignments (Part 3, dropped below) and
    # departments itself are going away. Each surviving table's FK must be
    # dropped and recreated pointing at roles.id (data values are unchanged:
    # department_id already holds the department's UUID, and every
    # department row was just re-inserted into roles with a NEW id via
    # dept_id_to_role_id -- so the column's VALUE must be rewritten too, not
    # just the constraint target).
    for table_name, ondelete in (
        ('employee_position_assignments', 'SET NULL'),
        ('department_leadership_assignments', 'CASCADE'),
        ('employee_reporting_relationships', 'SET NULL'),
    ):
        existing_fk = _fk_constraint_name(table_name, 'department_id', 'departments')
        if existing_fk:
            op.drop_constraint(existing_fk, table_name, type_='foreignkey')

        for old_id, new_id in dept_id_to_role_id.items():
            conn.execute(text(
                f"UPDATE {table_name} SET department_id = :new_id WHERE department_id = :old_id"
            ), {"new_id": new_id, "old_id": old_id})

        op.create_foreign_key(
            f'{table_name}_department_id_fkey', table_name, 'roles',
            ['department_id'], ['id'], ondelete=ondelete,
        )

    # --- 5. Drop the now-redundant tables -------------------------------------------------
    op.drop_table('employee_department_assignments')
    op.drop_table('departments')


def downgrade() -> None:
    # Data merged into roles/user_roles is not un-merged on downgrade (the
    # department/employee_department_assignments rows this migration created
    # from would need to be reconstructed from roles.code/parent_department_id
    # and user_roles' new columns, which is lossy in the no-login-employee
    # case documented above). Restoring the dropped tables' schema without
    # their data would be actively misleading, so this migration refuses to
    # downgrade rather than pretend to.
    raise NotImplementedError(
        "This migration's data merge is not reversible. Restore from a pre-migration backup "
        "if you need to roll back past this point."
    )