"""merge employee into user

Revision ID: d4h5p6q7r8s9
Revises: c3g4o5p6q7r8
Create Date: 2026-09-02 18:00:00.000000

Organization, Employee, Identity & Access Management upgrade -- Merge phase, Part 2.

Business decision: maintaining a separate ``Employee`` (workforce/person)
entity alongside ``User`` (login account) required deciding, for every
new person, "is this a User or an Employee?" -- and the common case (a
person who also needs to log in) meant creating and linking two records
across two screens. This migration merges ``Employee`` back into
``User``: login becomes OPTIONAL per person (``users.has_login``) rather
than a separate entity's presence/absence.

Schema changes on ``users``:
  - ``username``, ``email``, ``phone``, ``password_hash`` become NULLable
    (a no-login person has none of these).
  - New column ``has_login`` (NOT NULL, default true for all EXISTING
    rows -- every user who could already log in keeps being able to).

Data migration:
  - For every ``employees`` row with a linked ``user_id``: update that
    User row with any employee field that the User row doesn't already
    have set (the User row wins on conflicts, since it's the
    already-in-use record for that person).
  - For every ``employees`` row with NO linked ``user_id``: INSERT a new
    User row with ``has_login=false`` and no credentials, carrying over
    the employee's profile fields. This new User row's id becomes the
    reference point for updating the three FK tables below.

FK retargeting (employees.id -> users.id), via the just-established
employee-id -> user-id mapping:
  - ``employee_position_assignments.employee_id``
  - ``department_leadership_assignments.employee_id``
  - ``employee_reporting_relationships.employee_id`` and ``.manager_employee_id``

After copying data and retargeting FKs, ``employees`` is dropped.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
import app.database.base


# revision identifiers, used by Alembic.
revision = 'd4h5p6q7r8s9'
down_revision = 'c3g4o5p6q7r8'

branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    def _fk_constraint_name(table_name: str, column_name: str) -> str:
        """
        Look up the actual (Postgres-auto-generated) FK constraint name for
        a column, rather than assuming the default `<table>_<column>_fkey`
        naming -- these tables were created without an explicit
        naming_convention on the metadata, so Postgres's default applies,
        but querying it directly is more robust than hardcoding a guess.
        """
        result = conn.execute(text(
            "SELECT tc.constraint_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema "
            "WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = :table_name "
            "  AND kcu.column_name = :column_name"
        ), {"table_name": table_name, "column_name": column_name}).fetchone()
        if result is None:
            raise RuntimeError(
                f"Could not find an existing FK constraint on {table_name}.{column_name} -- "
                "cannot safely retarget it. Check the table was created as expected."
            )
        return result[0]

    # --- 1. Schema changes on users --------------------------------------------------
    op.add_column('users', sa.Column('has_login', sa.Boolean(), nullable=False, server_default=sa.true()))
    op.alter_column('users', 'username', existing_type=sa.String(length=100), nullable=True)
    op.alter_column('users', 'email', existing_type=sa.String(length=255), nullable=True)
    op.alter_column('users', 'phone', existing_type=sa.String(length=30), nullable=True)
    op.alter_column('users', 'password_hash', existing_type=sa.String(length=255), nullable=True)

    # --- 2. Migrate employees -> users, building an employee_id -> user_id map ------
    employee_rows = conn.execute(text(
        "SELECT id, user_id, employee_code, first_name, middle_name, last_name, display_name, "
        "email, phone, date_of_birth, gender, date_of_joining, employment_type, employment_status, "
        "profile_picture_url, address, city, state, country, postal_code, emergency_contact, notes, "
        "created_at, updated_at, created_by, updated_by "
        "FROM employees WHERE deleted_at IS NULL"
    )).fetchall()

    employee_id_to_user_id: dict = {}

    for row in employee_rows:
        if row.user_id is not None:
            # Linked employee: the User row already exists and is the
            # in-use record for this person (it may have its own username/
            # email/phone already) -- only fill in User columns that are
            # currently NULL, using the Employee's value. The User row's
            # existing non-NULL values always win, since that's the record
            # actually in use for login/identity today.
            employee_id_to_user_id[str(row.id)] = str(row.user_id)
            conn.execute(text(
                "UPDATE users SET "
                "  employee_code = COALESCE(employee_code, :employee_code), "
                "  display_name = COALESCE(display_name, :display_name), "
                "  date_of_birth = COALESCE(date_of_birth, :date_of_birth), "
                "  gender = COALESCE(gender, :gender), "
                "  date_of_joining = COALESCE(date_of_joining, :date_of_joining), "
                "  employment_type = COALESCE(employment_type, :employment_type), "
                "  employment_status = COALESCE(employment_status, :employment_status), "
                "  profile_picture_url = COALESCE(profile_picture_url, :profile_picture_url), "
                "  address = COALESCE(address, :address), "
                "  city = COALESCE(city, :city), "
                "  state = COALESCE(state, :state), "
                "  country = COALESCE(country, :country), "
                "  postal_code = COALESCE(postal_code, :postal_code), "
                "  emergency_contact = COALESCE(emergency_contact, :emergency_contact), "
                "  notes = COALESCE(notes, :notes) "
                "WHERE id = :user_id"
            ), {
                "employee_code": row.employee_code, "display_name": row.display_name,
                "date_of_birth": row.date_of_birth, "gender": row.gender,
                "date_of_joining": row.date_of_joining, "employment_type": row.employment_type,
                "employment_status": row.employment_status, "profile_picture_url": row.profile_picture_url,
                "address": row.address, "city": row.city, "state": row.state, "country": row.country,
                "postal_code": row.postal_code, "emergency_contact": row.emergency_contact,
                "notes": row.notes, "user_id": str(row.user_id),
            })
        else:
            # Unlinked employee: no User row exists for this person yet --
            # insert one with has_login=false and no credentials. Username/
            # email/phone are intentionally left NULL even if the Employee
            # row happened to have an email/phone on file (those were
            # contact-info fields, not login identifiers, for an
            # unlinked employee) -- has_login=false is what actually
            # governs whether this person can authenticate, not whether
            # these columns happen to be populated.
            new_user_id = conn.execute(text(
                "INSERT INTO users (id, first_name, middle_name, last_name, display_name, "
                "employee_code, has_login, username, email, phone, password_hash, "
                "date_of_birth, gender, date_of_joining, employment_type, employment_status, "
                "profile_picture_url, address, city, state, country, postal_code, "
                "emergency_contact, notes, status, is_active, must_change_password, "
                "failed_login_count, created_by, updated_by, created_at, updated_at, version, deleted_at) "
                "VALUES (gen_random_uuid(), :first_name, :middle_name, :last_name, :display_name, "
                ":employee_code, false, NULL, NULL, NULL, NULL, "
                ":date_of_birth, :gender, :date_of_joining, :employment_type, :employment_status, "
                ":profile_picture_url, :address, :city, :state, :country, :postal_code, "
                ":emergency_contact, :notes, 'INACTIVE', true, false, "
                "0, :created_by, :updated_by, :created_at, :updated_at, 1, NULL) "
                "RETURNING id"
            ), {
                "first_name": row.first_name, "middle_name": row.middle_name, "last_name": row.last_name,
                "display_name": row.display_name, "employee_code": row.employee_code,
                "date_of_birth": row.date_of_birth, "gender": row.gender,
                "date_of_joining": row.date_of_joining, "employment_type": row.employment_type,
                "employment_status": row.employment_status, "profile_picture_url": row.profile_picture_url,
                "address": row.address, "city": row.city, "state": row.state, "country": row.country,
                "postal_code": row.postal_code, "emergency_contact": row.emergency_contact,
                "notes": row.notes, "created_by": row.created_by, "updated_by": row.updated_by,
                "created_at": row.created_at, "updated_at": row.updated_at,
            }).fetchone()
            employee_id_to_user_id[str(row.id)] = str(new_user_id[0])

    # --- 3. Retarget FK columns from employees.id to users.id -----------------------
    # Drop the old FKs/constraints that pointed at employees, retarget the
    # data using the map built above, then add new FKs pointing at users.
    op.drop_constraint(
        _fk_constraint_name('employee_position_assignments', 'employee_id'),
        'employee_position_assignments', type_='foreignkey',
    )
    op.drop_constraint(
        _fk_constraint_name('department_leadership_assignments', 'employee_id'),
        'department_leadership_assignments', type_='foreignkey',
    )
    op.drop_constraint(
        _fk_constraint_name('employee_reporting_relationships', 'employee_id'),
        'employee_reporting_relationships', type_='foreignkey',
    )
    op.drop_constraint(
        _fk_constraint_name('employee_reporting_relationships', 'manager_employee_id'),
        'employee_reporting_relationships', type_='foreignkey',
    )

    for old_id, new_id in employee_id_to_user_id.items():
        conn.execute(text("UPDATE employee_position_assignments SET employee_id = :new_id WHERE employee_id = :old_id"), {"new_id": new_id, "old_id": old_id})
        conn.execute(text("UPDATE department_leadership_assignments SET employee_id = :new_id WHERE employee_id = :old_id"), {"new_id": new_id, "old_id": old_id})
        conn.execute(text("UPDATE employee_reporting_relationships SET employee_id = :new_id WHERE employee_id = :old_id"), {"new_id": new_id, "old_id": old_id})
        conn.execute(text("UPDATE employee_reporting_relationships SET manager_employee_id = :new_id WHERE manager_employee_id = :old_id"), {"new_id": new_id, "old_id": old_id})

    op.create_foreign_key(
        'employee_position_assignments_employee_id_fkey', 'employee_position_assignments',
        'users', ['employee_id'], ['id'], ondelete='CASCADE',
    )
    op.create_foreign_key(
        'department_leadership_assignments_employee_id_fkey', 'department_leadership_assignments',
        'users', ['employee_id'], ['id'], ondelete='CASCADE',
    )
    op.create_foreign_key(
        'employee_reporting_relationships_employee_id_fkey', 'employee_reporting_relationships',
        'users', ['employee_id'], ['id'], ondelete='CASCADE',
    )
    op.create_foreign_key(
        'employee_reporting_relationships_manager_employee_id_fkey', 'employee_reporting_relationships',
        'users', ['manager_employee_id'], ['id'], ondelete='CASCADE',
    )

    # --- 4. Drop the now-redundant employees table -----------------------------------
    op.drop_table('employees')

    print(
        f"NOTICE: merged {len(employee_rows)} employee record(s) into users "
        f"({sum(1 for r in employee_rows if r.user_id is not None)} updated existing linked users, "
        f"{sum(1 for r in employee_rows if r.user_id is None)} new no-login users created)."
    )


def downgrade() -> None:
    # Irreversible for the same reason as the Department/Role merge
    # migration: reconstructing employees/employee_department_assignments
    # from the merged users/user_roles data would require guessing which
    # User rows were originally Employee-only, which this migration does
    # not track separately.
    raise NotImplementedError(
        "This migration's data merge is not reversible. Restore from a pre-migration backup "
        "if you need to roll back past this point."
    )
