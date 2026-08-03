"""
Audit Module (Phase 3).

Provides the application-wide audit trail: an append-only ``AuditLog``
model, a masking-aware service (:mod:`app.audit.service`), an automatic
capture middleware for every mutating request (:mod:`app.audit.middleware`
-- registered as ``app.middleware.audit_middleware.AuditMiddleware``), and
a read-only admin API (:mod:`app.audit.routes`) for browsing the trail.

See ``MERGE_NOTES.md`` / the architecture review report for the full
design rationale.
"""

