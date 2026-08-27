# AI Assistant & Developer Guidelines

## Living Documentation Policy (Mandatory)

Whenever any features, functions, API endpoints, database schemas, frontend components, or architecture components are added, modified, or removed in this codebase:

1. **Update `doc/SYSTEM_DOCUMENTATION.md`**:
   - Keep the file map, feature descriptions, and API route tables aligned with the current code.
   - If a new module, table, endpoint, page, or background worker is introduced, document its architecture, purpose, and usage in `doc/SYSTEM_DOCUMENTATION.md`.
   - Update the **Last Updated** timestamp and relevant section numbers.

2. **Zero Inaccuracies**:
   - Ensure file paths, schema references, and code references in `doc/SYSTEM_DOCUMENTATION.md` reflect the exact codebase state.
