"""
Employees Module.

Owns the ``Employee`` ORM model -- employee *profile* data only (NOT
payroll, attendance, or leave, which are out of scope for Phase 6) -- and
everything needed to manage it: ``models``, ``schemas``, ``repository``,
``service``, and ``routes``, following the same layout as every other
feature module.

An employee may optionally be linked to exactly one ``User`` account (see
``Employee.user_id``); the reverse is also true (one user, at most one
employee profile), enforced via a unique foreign key rather than a
separate association table since the relationship is strictly 1:1.
"""
