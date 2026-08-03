# Phase 6 — Core Organization & User Management

Adds the core master-data modules on top of the Phase 1–5 foundation
(auth, RBAC, audit, queue, cache, common API infrastructure). No existing
architecture was modified; every new module follows the same
`models` / `schemas` / `repository` / `service` / `dependencies` / `routes`
layout as `app.users`.

This ERP is **single-company only** — no multi-tenancy anywhere in these
modules.

## New modules

| Module | Table(s) | Notes |
|---|---|---|
| `app.organizations` | `organizations` | Singleton company profile. Service enforces at most one row. Cached under the `settings` cache namespace. |
| `app.departments` | `departments` | Self-referential parent hierarchy + optional `manager` (an `Employee`). Soft-delete. Cached (`NS_DEPARTMENTS`). |
| `app.designations` | `designations` | Flat job-title/level list. Hard-delete (no soft-delete mixin). Cached (`NS_DESIGNATIONS`). |
| `app.employees` | `employees` | Employee **profile** only — NOT payroll/attendance/leave. Soft-delete. Optional 1:1 link to `users`. |

### Circular FK note
`departments.manager_id` → `employees.id` and `employees.department_id` →
`departments.id` are mutually referential. The model declares
`manager_id` with `use_alter=True`, and the migration creates `departments`
first (without that FK), then `employees`, then adds the FK via a
deferred `ALTER TABLE` (`fk_departments_manager_id`).

## Endpoints (all under `/api/v1`)

- `GET/POST/PATCH /organizations` — `organization.manage`
- `POST/GET/GET{id}/PATCH/DELETE /departments` — `department.create|read|update|delete`
- `POST/GET/GET{id}/PATCH/DELETE /designations` — `designation.create|read|update|delete`
- `POST/GET/GET{id}/PATCH/DELETE /employees` — `employee.create|read|update|delete`
  - `POST /employees/{id}/transfer-department`
  - `POST /employees/{id}/change-designation`
  - `POST /employees/{id}/assign-manager` (send `manager_id: null` to clear)
  - `POST /employees/{id}/link-user`
  - `POST /employees/{id}/deactivate`
  - `POST /employees/{id}/reactivate`

All list endpoints (`departments`, `designations`, `employees`) support the
standard `?search=&sort_by=&sort_order=&page=&page_size=` plus dynamic
exact-match filters (e.g. `?employment_status=ACTIVE&department_id=...`),
via the existing `ListQueryParams`/`BaseRepository.paginated_list`
framework — no new query-parsing code was written.

## Validation implemented

- Unique `employee_code` (auto-generated, e.g. `EMP00001`; sequence never
  reissued even for soft-deleted rows), unique email, unique phone
  (optional).
- Department/designation existence checked before assignment.
- Circular manager assignment prevented by walking the manager chain
  (`EmployeeRepository.get_manager_chain_ids`); an employee also cannot be
  their own manager.
- Circular department-parent assignment prevented the same way
  (`DepartmentRepository.get_descendant_ids`); a department cannot be its
  own parent.
- Department/designation `code` uniqueness.
- A `User` can be linked to at most one `Employee` and vice versa
  (`Employee.user_id` is a unique FK); enforced at both the service layer
  and the database.

## Integration with existing infrastructure

- **RBAC**: every mutating/reading route is gated by
  `require_permission(...)`; new permission codes added to
  `scripts/seed.py`'s bootstrap set: `department.*`, `designation.*`,
  `employee.*`, `organization.manage`.
- **Audit**: every mutation calls `AuditService.record(...)` directly
  (richer, action-specific descriptions) and sets
  `request.state.audit_logged = True`, so the audit middleware's generic
  fallback doesn't double-log — the same pattern `app.users.routes` uses.
- **Cache**: departments/designations/organization settings use the
  existing named `CacheManager` helpers (`get_departments`/
  `invalidate_departments`, etc.) that were already present in
  `app.cache.manager` from Phase 5, just unused until now.
- **Queue**: not used yet, per the Phase 6 spec ("keep architecture ready").
- **Standard response envelope / pagination / filtering / search /
  sorting**: 100% reused from `app.common` and `app.core.responses` — no
  new response-shaping code.

## Migration

`alembic/versions/c8f4a2b1e6d7_phase6_organization_and_hr.py` — adds
`organizations`, `designations`, `departments`, `employees`, plus the
deferred `fk_departments_manager_id` foreign key. Chains after
`b7e2f1a9c3d4` (the latest Phase 1–5 migration).

Run with:

```bash
alembic upgrade head
python -m scripts.seed   # picks up the new permission codes idempotently
```

## Known gaps / follow-ups

This environment has no network access and no Postgres instance, so the
migration and endpoints were verified by careful static review and
`py_compile`, not by actually booting the app or running `pytest`/
`alembic upgrade head` against a live database. Before deploying:

1. Run `alembic upgrade head` against a real Postgres instance and confirm
   the deferred FK step succeeds.
2. Run the existing test suite (`pytest`) plus new tests for the four
   modules (not yet written — `tests/test_health.py`,
   `test_cache.py`, `test_queue.py` are the existing pattern to follow).
3. The simple admin frontend (Dashboard, Organization Settings,
   Departments, Designations, Employees, Employee Details, Create/Edit
   Employee) called for in the spec has not been built yet in this pass.
