"""
Common Module.

Reusable, generic building blocks shared by every feature module:

- ``base_repository`` : a generic async CRUD repository over any ORM model
- ``base_service``     : a generic service layer built on top of a repository
- ``pagination``       : shared pagination request/response schemas
- ``schemas``          : small shared Pydantic schema pieces

Feature modules (``app.users``, ``app.departments``, etc.) subclass these
base classes instead of re-implementing CRUD boilerplate, in line with the
DRY and Open/Closed principles: base classes are open for extension
(override/add methods) but the common logic is written once.
"""
