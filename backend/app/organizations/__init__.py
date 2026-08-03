"""
Organizations Module.

Owns the ``Organization`` ORM model -- the single company profile for this
ERP instance. This ERP is single-company only (no multi-tenancy); the
service layer enforces that at most one organization row can ever exist.
"""
