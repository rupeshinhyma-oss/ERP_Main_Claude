# Enterprise ERP System — Unified Architecture, Feature & Technical Manual

> **System Version:** 1.0.0 (Production)  
> **Last Updated:** September 2026  
> **Architectural Pattern:** Modular Async Monolith (FastAPI) + React 18 SPA (Vite) + Real-Time WebSocket Event Bus  
> **Target Audience:** Systems Architects, Software Engineers, DevOps, and Autonomous AI Coding Assistants.  
> **Scope:** Complete end-to-end technical reference containing all system features, data models, API endpoints, background workers, frontend architecture, and developer integration guidelines.

---

## Table of Contents

1. [Executive Architecture & System Topology](#1-executive-architecture--system-topology)
2. [Technology Stack & Dependencies](#2-technology-stack--dependencies)
3. [Directory Layout & File Map](#3-directory-layout--file-map)
4. [Database Architecture & Universal Mixins](#4-database-architecture--universal-mixins)
5. [Complete Data Models & Entity Dictionary](#5-complete-data-models--entity-dictionary)
6. [Security, Authentication & Session Engine](#6-security-authentication--session-engine)
7. [RBAC Engine, Departments & Effective Permissions](#7-rbac-engine-departments--effective-permissions)
8. [Module-by-Module Technical Breakdown](#8-module-by-module-technical-breakdown)
   - 8.1. [Authentication & Active Sessions](#81-authentication--active-sessions)
   - 8.2. [Users & HR Profile Management](#82-users--hr-profile-management)
   - 8.3. [Departments & Department Managers](#83-departments--department-managers)
   - 8.4. [Master Data & Generic Catalogs](#84-master-data--generic-catalogs)
   - 8.5. [Product Catalog & Dynamic Specification Builder](#85-product-catalog--dynamic-specification-builder)
   - 8.6. [Supplier Directory & Tokenized Public Portal](#86-supplier-directory--tokenized-public-portal)
   - 8.7. [Buyer & Client Management](#87-buyer--client-management)
   - 8.8. [Inquiries, RFQs & AI Quotation Extractor](#88-inquiries-rfqs--ai-quotation-extractor)
   - 8.9. [Automated Inbound IMAP Email Worker](#89-automated-inbound-imap-email-worker)
   - 8.10. [Master Shipment Planning Grid & Container Calculations](#810-master-shipment-planning-grid--container-calculations)
   - 8.11. [Audit Trails & JSON Delta Change Diffing](#811-audit-trails--json-delta-change-diffing)
   - 8.12. [Recycle Bin (Universal Soft-Delete & Recovery)](#812-recycle-bin-universal-soft-delete--recovery)
   - 8.13. [Organization & System Profile](#813-organization--system-profile)
   - 8.14. [Employee Directory & Organization Structure](#814-employee-directory--organization-structure-identity--access-management-upgrade)

9. [Real-Time WebSocket & Event Synchronization](#9-real-time-websocket--event-synchronization)
10. [Multi-Tier Caching Engine](#10-multi-tier-caching-engine)
11. [Universal Bulk Import & Export Wizard](#11-universal-bulk-import--export-wizard)
12. [Frontend Architecture & Single-Flight Token Refresh](#12-frontend-architecture--single-flight-token-refresh)
13. [Complete API Route & Endpoint Directory](#13-complete-api-route--endpoint-directory)
14. [Developer & AI Integration Guide (Rules of Engagement)](#14-developer--ai-integration-guide-rules-of-engagement)
15. [Deployment, Environment Variables & Operations](#15-deployment-environment-variables--operations)

---

## 1. Executive Architecture & System Topology

```
+---------------------------------------------------------------------------------------------------+
|                                          CLIENT TIER                                              |
|  React 18 Single Page App  |  IHM Design System (Vanilla CSS)  |  WebSocket Real-Time Listener    |
+-------------------------------------------------+-------------------------------------------------+
                                                  | HTTPS / WSS JSON API
+-------------------------------------------------v-------------------------------------------------+
|                                     FASTAPI APPLICATION TIER                                      |
|                                                                                                   |
|  [Middleware Pipeline: CORS -> Rate Limiting -> Request Logging -> Security Headers -> Context]   |
|                                                                                                   |
|  +---------------------------+  +---------------------------+  +-------------------------------+  |
|  | Authentication & Sessions |  | RBAC & Department Engine  |  | Inquiries & RFQ Lifecycle     |  |
|  | - Argon2id Password Hash  |  | - Hierarchical Roles      |  | - Multi-Vendor RFQ Tracking   |  |
|  | - JWT Access & Refresh    |  | - Dynamic Permissions     |  | - Quotation Matrix Comparison |  |
|  | - Single-Flight Refresh   |  | - User Override Engine    |  | - AI Extraction (GPT-4o/Gemini|  |
|  +---------------------------+  +---------------------------+  +-------------------------------+  |
|  | Master Data & Catalogs    |  | Sourcing & Partners       |  | Master Planning Engine        |  |
|  | - Dynamic Specs Engine    |  | - Suppliers & Contacts    |  | - Dynamic Sheet/Row/Col/Cell  |  |
|  | - Multilevel Categories   |  | - Public Tokenized Portal |  | - Container CBM Optimization  |  |
|  | - Currencies & Geography  |  | - Buyers & Credit Limits  |  | - Cell Status Tagging Engine  |  |
|  +---------------------------+  +---------------------------+  +-------------------------------+  |
|  | Background Workers        |  | Real-Time Event Engine    |  | Governance & Recovery         |  |
|  | - IMAP Email Inbound Poll |  | - WebSocket Manager       |  | - Immutable Audit Logger      |  |
|  | - AI Attachment Extractor |  | - JSON Mutation Broadcast |  | - Universal Soft-Delete / Bin |  |
|  | - Cache Eviction Daemon   |  | - Conflict Prevention     |  | - Field-Level JSON Delta Diff |  |
|  +---------------------------+  +---------------------------+  +-------------------------------+  |
+--------------------------------+----------------------------+-------------------------------------+
                                 |                            |
+--------------------------------v-------+  +-----------------v-------+  +--------------------------+
|            PERSISTENCE TIER            |  |       CACHING TIER      |  |       STORAGE TIER       |
| PostgreSQL / SQLite (SQLAlchemy Async) |  | Redis / InMemoryCache   |  | Local / Cloud Uploads    |
| Alembic Versioned Migrations           |  | Namespace-Based Cache   |  | Quotations, PDFs, Images |
+----------------------------------------+  +-------------------------+  +--------------------------+
```

### 1.1. Core Architectural Pillars
1. **Strict Onion Architecture**: `routes -> services -> repositories -> database`. Routes handle transport and authentication; services orchestrate business validation, audit logging, and caching; repositories build optimized async SQLAlchemy queries.
2. **Unified Response Envelope**: Every HTTP response is structured as `{ "success": true, "data": ..., "meta": ..., "error": null }`. Error responses provide the same uniform contract with a standardized error code and debug message.
3. **Domain Exceptions Hierarchy**: Business logic raises framework-agnostic exceptions (`NotFoundException`, `ConflictException`, `ForbiddenException`, `ValidationException`) translated into standard HTTP envelopes at the middleware boundary.
4. **Optimistic Concurrency**: Records implement integer `version` attributes to prevent dirty overwrites during simultaneous concurrent edits.
5. **Universal Soft-Deletion**: Records inherit `SoftDeleteMixin` (`deleted_at`, `deleted_by`). Deletion operations move data to the Recycle Bin for one-click restoration.

---

## 2. Technology Stack & Dependencies

### Backend Stack
- **Framework**: FastAPI (Python 3.11+) with Uvicorn ASGI server.
- **ORM & Database**: SQLAlchemy 2.0 Async (`asyncpg` for PostgreSQL, `aiosqlite` for local dev) with Alembic migration versioning.
- **Data Validation**: Pydantic v2 schemas for high-throughput serialization.
- **Authentication**: Argon2id password hashing (`argon2-cffi`) and PyJWT (HMAC-SHA256).
- **Caching**: Dual-backend (`InMemoryCacheBackend` with LRU eviction and Redis client).
- **AI Processing**: OpenAI GPT-4o-mini / Google Gemini multimodal APIs for quote extraction from PDF/Excel/image documents.
- **PDF & Office Tooling**: `ReportLab` for PDF datasheets and `openpyxl` / `pypdf` for spreadsheet and document parsing.

### Frontend Stack
- **Core Framework**: React 18 with strict TypeScript typing.
- **Build Engine**: Vite with optimized Rollup code splitting.
- **Styling**: Vanilla CSS (IHM Design System) with custom tokens (glassmorphism, vibrant badges, accessible inputs).
- **Data Utilities**: `SheetJS` (xlsx) and `PapaParse` for client-side spreadsheet import/export.
- **Real-Time Client**: Native WebSocket `LiveClient` with automatic exponential backoff reconnection.

---

## 3. Directory Layout & File Map

```
ERP_Main_Claude/
├── AGENTS.md                  # Mandatory AI and Developer Living Documentation Policy
├── doc/
│   ├── README.md              # Central documentation index
│   └── SYSTEM_DOCUMENTATION.md# Master Unified Architecture & Feature Manual (THIS FILE)
├── backend/
│   ├── app/
│   │   ├── api/v1/router.py   # Versioned API route registration
│   │   ├── audit/             # Immutable audit log models, service, and routes
│   │   ├── auth/              # JWT auth, Argon2id, session tracking, rate limiting
│   │   ├── buyers/             # Buyer directory, contacts, addresses, credit limits
│   │   ├── cache/              # Redis / in-memory cache manager, cleanup worker
│   │   ├── common/             # BaseRepository, BaseService, Pagination, Storage, Importer, Email
│   │   ├── core/                # Config, Responses, Exceptions, Exception Handlers, Logging
│   │   ├── database/           # Async Engine, Session DI, Declarative Base Mixins
│   │   ├── employees/          # Employee (workforce/person) records, optional User Account link
│   │   ├── events/              # WebSocket connection manager and broadcast bus
│   │   ├── inquiries/          # RFQ lifecycle, AI Quote Extractor, IMAP email poller
│   │   ├── masters/           # Brands, Categories, Subcategories, Geography, Currencies
│   │   ├── middleware/        # Correlation ID, Logging, Security, Rate Limiter
│   │   ├── organizations/     # Enterprise profile settings
│   │   ├── org_structure/     # Departments, Positions, Leadership, Reporting Structure (IAM upgrade)
│   │   ├── planning/          # Dynamic spreadsheet planning grid, container CBM calculator
│   │   ├── rbac/              # Roles, Permissions, User Overrides, Effective Permissions
│   │   ├── suppliers/         # Supplier directory, tokenized public quote portal
│   │   ├── trash/             # Universal Recycle Bin recovery service
│   │   ├── users/             # User accounts, HR profiles, reporting managers
│   │   └── main.py            # Composition root, lifespan lifecycle, middleware wiring
│   ├── alembic/               # Database schema version migrations
│   ├── scripts/               # Migration and maintenance tools (sync_uploads_to_supabase.py)
│   └── requirements.txt       # Python dependencies
└── frontend/
    ├── src/
    │   ├── components/        # AppShell, MasterPage, SearchableDropdown, ImportWizard, UI, icons
    │   ├── lib/               # API client, Auth Context, Navigation registry (nav.ts), WebSockets
    │   ├── pages/             # Inquiries, Planning, Suppliers, Buyers, Users, Rbac, Profile
    │   │   ├── masters/       # Products, Brands, Categories, Currencies, Cities, Countries
    │   │   └── org/           # Positions, Organization Chart (dynamic org hierarchy)
    │   ├── styles/            # IHM Design System stylesheet (style.css, pages.css)
    │   └── types/             # Strict TypeScript domain interfaces
    └── package.json           # Frontend dependencies and build scripts
```

---

## 4. Database Architecture & Universal Mixins

All database models reside in `backend/app/` and inherit from declarative mixins defined in `backend/app/database/base.py`:

```python
class UUIDPrimaryKeyMixin:
    """Provides a RFC 4122 UUID v4 primary key column."""
    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)

class TimestampMixin:
    """Tracks UTC creation and update timestamps."""
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)

class SoftDeleteMixin:
    """Provides non-destructive lifecycle management."""
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True)

class VersionMixin:
    """Provides optimistic concurrency control."""
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
```

---

## 5. Complete Data Models & Entity Dictionary

```mermaid
erDiagram
    USERS ||--o{ USER_ROLES : assigned
    ROLES ||--o{ USER_ROLES : holds
    ROLES ||--o{ ROLE_PERMISSIONS : defines
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : grants
    USERS ||--o{ USER_PERMISSIONS : overrides
    PERMISSIONS ||--o{ USER_PERMISSIONS : target
    USERS ||--o{ SESSIONS : registers

    ROLES ||--o{ ROLES : "parent_department (nested)"
    ROLES ||--o{ DEPARTMENT_HIERARCHY : "parent_department (multi)"
    ROLES ||--o{ DEPARTMENT_HIERARCHY : "child_department (multi)"
    USERS ||--o{ EMPLOYEE_POSITION_ASSIGNMENTS : holds
    POSITIONS ||--o{ EMPLOYEE_POSITION_ASSIGNMENTS : filled_by
    ROLES ||--o{ DEPARTMENT_LEADERSHIP_ASSIGNMENTS : led_by
    USERS ||--o{ DEPARTMENT_LEADERSHIP_ASSIGNMENTS : leads
    USERS ||--o{ EMPLOYEE_REPORTING_RELATIONSHIPS : "reports (as person)"
    USERS ||--o{ EMPLOYEE_REPORTING_RELATIONSHIPS : "manages (as manager)"

    BUYERS ||--o{ INQUIRIES : initiates
    INQUIRIES ||--o{ INQUIRY_ITEMS : contains
    INQUIRIES ||--o{ INQUIRY_SUPPLIER_QUOTES : receives
    SUPPLIERS ||--o{ INQUIRY_SUPPLIER_QUOTES : submits
    
    CATEGORIES ||--o{ SUB_CATEGORIES : contains
    SUB_CATEGORIES ||--o{ PRODUCTS : classifies
    BRANDS ||--o{ PRODUCTS : manufactures
    PRODUCTS ||--o{ INQUIRY_ITEMS : references
    
    PLANNING_SHEETS ||--o{ PLANNING_COLUMNS : defines
    PLANNING_SHEETS ||--o{ PLANNING_ROWS : contains
    PLANNING_ROWS ||--o{ PLANNING_CELLS : stores
    PLANNING_COLUMNS ||--o{ PLANNING_CELLS : formats
```

---

## 6. Security, Authentication & Session Engine

### 6.1. Dual-Token JWT & Single-Flight Refresh
- **Access Token**: 15-minute expiration, contains `sub` (User UUID), `username`, `roles`, and base claims.
- **Refresh Token**: 7-day expiration, stored cryptographically in the `refresh_tokens` table. Each refresh token is strictly **single-use** and rotated upon every `/auth/refresh` call.
- **Single-Flight Frontend Guard**: When multiple parallel API calls encounter a `401 Unauthorized`, only a single refresh request is dispatched. All concurrent requests wait on the same promise, preventing race conditions and unexpected logouts.

### 6.2. Argon2id Password Encryption
Passwords are hashed using Argon2id with strict parameters:
- Time cost: 3 iterations
- Memory cost: 65,536 KB
- Parallelism: 4 threads
- Salt length: 16 bytes

### 6.3. Active Session Governance
Every authentication creates a record in the `sessions` table capturing IP address, location, browser user-agent, and device category. Users and administrators can inspect active sessions and revoke compromised devices remotely.

---

## 7. RBAC Engine, Departments & Effective Permissions

## 7. RBAC Engine, Departments & Effective Permissions

The platform unifies **Roles** and organizational **Departments** onto the same underlying entity (`roles` table). A Role carries software permission bundles (`role_permissions`) AND real organizational placement (`code` and `parent_department_id` for departmental hierarchy with server-side cycle detection). Assigning a user to a department grants that department's permissions and places the person in the organizational unit. Individual per-user overrides (`user_permissions` ALLOW/DENY) remain available for any user who needs to deviate from department defaults.

### 7.1. Effective Permission Calculation
User capabilities are calculated dynamically at request time:

$$\text{EffectivePermissions} = \left( \bigcup_{r \in \text{UserRoles}} \text{RolePermissions}(r) \cup \text{DirectGrants} \right) \setminus \text{DirectDenies}$$

A user may be assigned any number of Roles simultaneously (`POST /users/{id}/roles` is additive, carrying assignment metadata `assignment_type` [PRIMARY, SECONDARY, TEMPORARY, PROJECT, ACTING], `is_primary`, and effective dates).

*Super Admin Rule:* Users with the `super_admin` role bypass checks and possess all permissions unconditionally.

### 7.2. Department Managers & Leadership
- Department members can be designated as **Department Managers** or leadership assignees (`department_leadership_assignments`).
- Managers display a `MANAGER` badge on the department roster.
- Administrators can configure direct per-user permission overrides (`🔑 Edit permissions`) to give managers elevated operational privileges (e.g. deletion, approval, bulk exports) without altering the base department role.
- Setting a manager automatically updates the `manager_id` reporting hierarchy for department members.

### 7.3. Multi-Parent & Multi-Child Department Hierarchy
- **Entity Model (`department_hierarchy`)**: Supports many-to-many relationships between organizational departments (`parent_department_id` $\leftrightarrow$ `child_department_id`).
- **Bidirectional Relationship**:
  - A parent department can possess **multiple child departments** (sub-departments).
  - A child department can report to or be nested under **multiple parent departments**.
- **DAG Cycle Prevention**: Traversing both `department_hierarchy` and legacy `roles.parent_department_id` via breadth-first search prevents direct or indirect recursive loops across the departmental graph. Attempted cycles fail fast with HTTP `409 Conflict` ("This would create a circular department hierarchy.").
- **Backward Compatibility**: Automatically mirrors and backfills the primary parent to `roles.parent_department_id` for legacy single-parent queries.

---

## 8. Module-by-Module Technical Breakdown

### 8.1. Authentication & Active Sessions
- **Endpoints:** `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/{id}`.
- **Features:** Self-service password change, active session listing, device revocation, and forced password reset on first login. Users with `has_login=False` cannot authenticate and are rejected before password hashing.

### 8.2. Users & HR Profile Management (Unified Person & Workforce Directory)
- **Endpoints:** `GET /users`, `GET /users/all`, `GET /users/department-manager/{role_id}`, `POST /users`, `GET /users/{id}`, `PATCH /users/{id}`, `POST /users/{id}/reset-password`, `POST /users/{id}/roles`, `DELETE /users/{id}/roles/{role_id}`.
- **Features:** Unified person directory supporting both ERP login users and workforce members with no system credentials (`has_login=False` -- factory workers, drivers, temporary labor, consultants).
  - **Account Fields:** `username`, `email`, `phone`, `password` (required when `has_login=True`; optional/null when `has_login=False`), and optional initial `position_id`.
  - **HR Attributes:** Employee Code, Contact Numbers, Gender, Date of Birth, Date of Joining, Employment Type, Status, Address, Emergency Contact, and Notes. **Last Name is optional**.
  - **Default "User" Role Assignment:** If an individual is not explicitly assigned any department/role upon creation (or if unassigned), the system automatically assigns the default system **"User"** role. When all roles are removed from a person, the system automatically falls back to assigning the "User" role.
  - **Position Assignment & Editing:** When creating an account, an optional **Position** dropdown (extracted from the active Positions catalog) can be selected to establish an immediate primary position assignment. In the **Edit User Profile & HR Details** drawer, administrators can also view, update, reassign, or unset the user's primary position directly alongside the Reporting Manager selector, with changes synchronized atomically to `employee_position_assignments`.
  - **Department & Manager Auto-Wiring:** When selecting an initial department in the Create User modal, the system calls `/users/department-manager/{role_id}` to automatically detect and pre-fill the department's active manager, with manual override capability.
  - **Positions & Reporting:** Profile Drawer displays held positions (`GET /positions/holders-for-user/{id}`), reporting managers (`GET /reporting/managers/{id}`), and direct reports (`GET /reporting/direct-reports/{id}`).
  - **Multi-Role Assignment:** Assign any number of roles/departments with `assignment_type` (PRIMARY, SECONDARY, TEMPORARY, PROJECT, ACTING), `is_primary`, and effective date ranges.

### 8.3. Departments & Permissions (RBAC & Org Structure)
- **Endpoints:** `GET /rbac/roles`, `POST /rbac/roles`, `PATCH /rbac/roles/{id}`, `DELETE /rbac/roles/{id}`, `POST /rbac/roles/{id}/delete-with-reassignment`, `PUT /rbac/users/{id}/permissions/bulk`, `GET /rbac/roles/{id}/hierarchy`, `POST /rbac/roles/{id}/parents`, `DELETE /rbac/roles/{id}/parents/{parent_id}`, `POST /rbac/roles/{id}/children`, `DELETE /rbac/roles/{id}/children/{child_id}`.
- **Features:** Department role definitions with optional short department `code` (e.g. `SALES`), multi-parent department nesting, safe deletion with user reassignment modal, and permission cloning.
  - **Child Departments Card:** Dedicated card directly beneath "Users in this Department" in the left column of `/rbac`, displaying connected sub-departments, member counts, quick view navigation, and inline add/remove child controls.
  - **Multi-Parent Department Management:** Department Details allows assigning multiple parent departments with removable tag badges and immediate unlinking without resaving the entire role.
  - **Real-Time Bidirectional Sync:** Adding a child department in Operations instantly updates the child's parent roster, and vice versa.
  - **Cycle Prevention:** Strict validation prevents assigning an ancestor as a child or vice-versa.

### 8.4. Master Data & Generic Catalogs
- **Modules:** Brands, Categories, Sub-Categories, Countries, States, Cities, Currencies, Units of Measurement (UOM), HSN/SAC Codes, and Operating Companies.
- **Features:** Built on the unified `MasterPage.tsx` engine providing uniform search, pagination, validation, modal creation, and cached lookup resolution (`nameResolver.ts`).

### 8.5. Product Catalog & Dynamic Specification Builder
- **Endpoints:** `GET /products`, `POST /products`, `PATCH /products/{id}`, `POST /products/{id}/specs`, `GET /products/{id}/datasheet-pdf`.
- **Features:** Dynamic JSON specification builder allowing arbitrary technical specifications (e.g. Dimensions, Voltage, Speed, Material). Includes multi-image upload, supplier association, and ReportLab PDF datasheet generation.

### 8.6. Supplier Directory & Tokenized Public Portal
- **Endpoints:** `GET /suppliers`, `POST /suppliers`, `PATCH /suppliers/{id}`, `POST /suppliers/{id}/contacts`, `POST /suppliers/import`, `GET /suppliers/export`.
- **Features:** Vendor directory with multi-contact management, payment terms, and bank details. Generates secure, tokenized public quote portal links (`/quotes/public/:token`) allowing vendors to submit bids without system accounts.
- **Dynamic Geography & Phone Dialing Code Sync:** When changing Country in the Supplier Profile (e.g., China &rarr; India), Province and City dropdowns reset automatically, and the country dialing code prefixes on Calling Number, WhatsApp Number, and WeChat Number auto-update dynamically (e.g., `+86 7304240120` &rarr; `+91 7304240120`).

### 8.7. Buyer & Client Management
- **Endpoints:** `GET /buyers`, `POST /buyers`, `PATCH /buyers/{id}`, `POST /buyers/{id}/contacts`, `POST /buyers/{id}/addresses`.
- **Features:** Client directory with credit limits, client grades (A, B, C, Premium), multi-address delivery matrix (Billing, Shipping, Warehouse), and bulk import/export.

### 8.8. Inquiries, RFQs & AI Quotation Extractor
- **Endpoints:** `GET /inquiries`, `POST /inquiries`, `POST /inquiries/{id}/rfq/dispatch`, `POST /inquiries/{id}/send-email-message`, `GET /inquiries/{id}/messages`, `POST /inquiries/{id}/quotes/manual`, `POST /inquiries/{id}/quotes/extract-pdf`, `POST /inquiries/{id}/convert-to-proforma`, `GET /inquiries/{id}/compare-matrix`.
- **Features:**
  - 3-layer RFQ and Quotation management lifecycle: `Buyer Directory` $\rightarrow$ `Consignments` $\rightarrow$ `Line Items & Quotation Matrix`.
  - **Interactive Inline Email Composer (Gmail/Figma-Style)**: Located in the Inquiries -> Emails tab. Allows users to write custom follow-up emails or replies directly to suppliers, auto-selects recipient emails from known suppliers, pre-fills context-aware subject lines, attaches files, and immediately dispatches outbound SMTP emails. Dispatched emails are instantly recorded into the communication timeline.
  - **Strict 1-Quote AI Extraction Policy**: The inbound AI parsing worker only extracts quotation terms from initial inbound supplier replies. Subsequent follow-up correspondence and chats between sales personnel and suppliers are logged directly to the email timeline without AI duplication or spurious quotation matrix modifications.
  - All Expected Receiving Date date-pickers enforce `min={today}` to disable selecting past dates.
  - Outbound WeChat RFQ engine automatically resolves supplier 11-digit mobile numbers to WeCom User IDs via Tencent API using `httpx`.
  - Supabase Cloud Storage integration handles all quotation PDF attachments.
  - Full RFQ status progression: `DRAFT` $\rightarrow$ `SENT_TO_SUPPLIERS` $\rightarrow$ `QUOTES_RECEIVED` $\rightarrow$ `UNDER_EVALUATION` $\rightarrow$ `APPROVED` $\rightarrow$ `ORDER_PLACED` $\rightarrow$ `CLOSED`.
  - Side-by-side vendor quotation comparison matrix with lowest bid and fastest turnaround highlighting.
  - Multimodal AI quote extractor parsing PDFs, Excel sheets, and email text into structured bids (`ExtractedQuotation`).
  - 1-Quote negotiation iteration tracking and turnaround time metrics.

### 8.9. Automated Inbound IMAP Email Worker
- **File:** `backend/app/inquiries/email_inbound_worker.py`
- **Features:** Background daemon running every 60 seconds. Connects via secure IMAP, checks for inquiry reference tokens in email subjects/headers, downloads quote attachments, triggers AI extraction, and logs quotation bids automatically. Avoids duplicate processing via `processed_email_ids.json`.

### 8.10. Master Shipment Planning Grid & Container Calculations
- **Endpoints:** `GET /planning/sheets`, `POST /planning/sheets`, `GET /planning/sheets/{id}/grid`, `GET /planning/sheets/{id}/filter-values`, `GET /planning/organization-search`, `POST /planning/rows`, `POST /planning/columns`, `PATCH /planning/cells`, `POST /planning/container-calc`.
- **Features:**
  - Dynamic grid model (`planning_sheets` $\rightarrow$ `planning_rows` $\rightarrow$ `planning_columns` $\rightarrow$ `planning_cells`).
  - Column data types (`TEXT`, `NUMBER`, `DATE`, `BOOLEAN_YN`) and source types (`MANUAL`, `LINKED_LOOKUP`, `AGGREGATE`, `FORMULA_CALCULATION`).
  - **Organization-Wide Cross-Branch Search Bar**: Top-level search bar dynamically scans across all branches of the currently viewed organization (e.g. Inhyma Mumbai, Inhyma Ahmedabad, Inhyma Indore) via `/planning/organization-search`. Provides instant branch-wise result counts, previews matching items, filters the active grid live, and allows one-click switching to any branch tab.
  - **Full-Dataset Column Filtering & Live Search**: Filter popover dynamically queries distinct values and occurrence counts across all records on the sheet (1384+ items) via `/planning/sheets/{id}/filter-values` with debounced text search, ensuring unrendered and newly created Product Master records are fully searchable.
  - **Automated Product Master Auto-Population**: Automatically syncs and materializes unlinked products for the sheet's organization and branch upon sheet load or filter search.
  - Cell status color tagging (e.g. `status-ordered`, `status-purchased`).
  - Container calculation engine computing total volume in CBM and payload weight across 20FT, 40FT, 40FT HC, and LCL container configurations.
  - Group-wise subcategory & product sorting.

### 8.11. Audit Trails & JSON Delta Change Diffing
- **Endpoints:** `GET /audit`, `GET /audit/{id}`, `GET /audit/export`.
- **Features:** Immutable audit repository capturing actor, IP, timestamp, action type, and field-level before/after JSON delta diffs across all business entities.

### 8.12. Recycle Bin (Universal Soft-Delete & Recovery)
- **Endpoints:** `GET /trash`, `POST /trash/{entity_type}/{id}/restore`, `DELETE /trash/{entity_type}/{id}/purge`.
- **Features:** Centralized Recycle Bin displaying soft-deleted records across all tables. One-click recovery restores records with full relational integrity. Permanent purge is restricted to Super Administrators.

### 8.13. Organization & System Profile
- **Endpoints:** `GET /organizations/profile`, `PATCH /organizations/profile`.
- **Features:** Enterprise legal identity, tax/VAT/TIN registration, official address, and base operational currency.

### 8.14. Organization Structure, Positions & Reporting Hierarchy
- **Files:** `backend/app/org_structure/`.
- **Architecture:** Unifies workforce identity into `User` (`has_login` boolean) and department management into `Role` (`code`, `parent_department_id`). Complemented by dedicated organizational modules:
- **Positions (`/positions`):** Designations/titles (e.g. "Sales Manager", "Marketing Advisor"). Managed via `Position` and assigned to users via `employee_position_assignments` (supporting PRIMARY, SECONDARY, ACTING, TEMPORARY roles). Holds no permission or reporting logic. Creation and updates support case-insensitive lifecycle status (`ACTIVE`, `INACTIVE`, `ARCHIVED`).
  - **Employee Assignment Count & Deletion Lock:** `GET /positions` and `GET /positions/all` dynamically aggregate active assignment counts (`employee_count`). If any employees currently hold a position (`employee_count > 0`), the position's delete button is completely frozen and locked on the UI with a lock icon, `cursor: not-allowed`, tooltip warning, and an explanatory modal alert preventing deletion. Server-side deletion enforcement (`PositionService.delete`) strictly rejects deletions with HTTP 409 Conflict if active assignments exist.
- **Department Leadership:** `department_leadership_assignments` records who manages/heads a department (`department_id` references `roles.id`, `employee_id` references `users.id`). The same user may lead multiple departments; a department may have multiple leadership assignees.
- **Reporting Structure (`/reporting`):** Person-to-person reporting lines in `employee_reporting_relationships` (`employee_id` and `manager_employee_id` referencing `users.id`). Supports relationship types (`PRIMARY_REPORTING`, `FUNCTIONAL_REPORTING`, `PROJECT_REPORTING`, `DOTTED_LINE`, `TEMPORARY_REPORTING`) and optional department scoping.
  - **Mandatory Server-Side Cycle Prevention:** `ReportingService.would_create_cycle` verifies the reporting graph before any row is saved, immediately rejecting self-reporting (`A -> A`) and circular chains (`A -> B -> C -> A`) with a 409 Conflict.
  - **Direct Reports Reassignment:** `POST /reporting/reassign-direct-reports/{manager_id}` allows reassigning all direct reports before deactivating a manager.
  - **Set / Move Primary Manager (Org Chart):** `POST /reporting/set-manager/{employee_id}` updates an employee's primary reporting manager in a single atomic transaction, validating cycle prevention and returning the updated relationship.
- **Dynamic Org Chart (`GET /reporting/org-chart`):** Renders the multi-level reporting tree in `/org-chart` using active `PRIMARY_REPORTING` relationships resolved dynamically against `UserRepository.list_all()`, including node `relationship_id`.

---

## 9. Real-Time WebSocket & Event Synchronization

**File:** `backend/app/events/manager.py` & `frontend/src/lib/live/liveClient.ts`

- **Endpoint:** `ws://<host>:<port>/api/v1/events/ws?token=<JWT_ACCESS_TOKEN>`
- **Behavior:** Broadcasts entity mutation events (`RECORD_CREATED`, `RECORD_UPDATED`, `RECORD_DELETED`) to all connected client tabs. Client pages selectively refresh datasets, preventing concurrent edit collisions.

---

## 10. Multi-Tier Caching Engine

**File:** `backend/app/cache/`

- **Dual-Backend:** Supports Redis in distributed environments and `InMemoryCacheBackend` (with LRU eviction) for local development.
- **Namespaces:** `permissions:<user_id>`, `dropdowns:<entity>`, `dashboard:counts`, `records:<entity>:<id>`.
- **Admin API:** `GET /cache/stats`, `GET /cache/keys`, `DELETE /cache/flush`, `DELETE /cache/namespace/{name}`.

---

## 11. Universal Bulk Import & Export Wizard

**Files:** `frontend/src/components/ImportWizard.tsx`, `backend/app/common/importer.py`

- **Workflow:** File Upload (.xlsx / .csv) $\rightarrow$ Header Fuzzy Matching $\rightarrow$ Column Mapping UI $\rightarrow$ Client-Side Validation $\rightarrow$ Transactional Batch Insertion $\rightarrow$ Error Log Report.
- **Duplicate Prevention:** Validates existing database records by TIN, Email, Phone, or Code before commit.

---

## 12. Frontend Architecture & Single-Flight Token Refresh

**Files:** `frontend/src/lib/api.ts`, `frontend/src/lib/authContext.tsx`, `frontend/src/components/AppShell.tsx`

- **Routing:** React Router v6 with `ProtectedRoute` guards and deep-link redirect preservation.
- **Error Boundaries:** Multi-layer error boundary protection with an application-level root boundary in `main.tsx` and a route-keyed boundary (`ErrorBoundary key={location.pathname}`) in `App.tsx` ensuring crashed page states do not leak across navigation transitions.
- **Component Design System:** Predefined accessible UI tokens in `frontend/src/components/ui.tsx` and `fields.tsx` (including interactive `TextField` with automatic password visibility eye toggle `showPasswordToggle`).
- **Hooks Architecture:** Custom hooks for asynchronous state management: `useAuth`, `usePendingGuard`, `useToast`, `usePagination`.

---

## 13. Complete API Route & Endpoint Directory

| Module | HTTP Method | Endpoint URI | Description | Permission Gate |
| :--- | :--- | :--- | :--- | :--- |
| **Auth** | `POST` | `/api/v1/auth/login` | Authenticate credentials & issue JWT pair | Public |
| **Auth** | `POST` | `/api/v1/auth/refresh` | Rotate single-use refresh token | Public (Valid Token) |
| **Auth** | `POST` | `/api/v1/auth/logout` | Revoke refresh token & active session | Authenticated |
| **Auth** | `GET` | `/api/v1/auth/me` | Fetch profile & effective permissions | Authenticated |
| **Auth** | `GET` | `/api/v1/auth/sessions` | List active user device sessions | Authenticated |
| **Auth** | `DELETE`| `/api/v1/auth/sessions/{id}` | Revoke specific device session | Authenticated |
| **Users** | `GET` | `/api/v1/users` | List paginated users with search/sort | `user.read` |
| **Users** | `GET` | `/api/v1/users/all` | List all users (unpaginated for manager lookups) | `user.read` |
| **Users** | `GET` | `/api/v1/users/department-manager/{role_id}` | Get active manager for a department/role | `user.read` |
| **Users** | `POST` | `/api/v1/users` | Create person record (login user or workforce member via `has_login`) | `user.create` |
| **Users** | `GET` | `/api/v1/users/{id}` | Inspect user details & roles | `user.read` |
| **Users** | `PATCH` | `/api/v1/users/{id}` | Update user profile / reporting manager | `user.update` |
| **Users** | `POST` | `/api/v1/users/{id}/reset-password` | Generate temporary login password | `user.reset_password` |
| **Users** | `POST` | `/api/v1/users/{id}/roles` | Assign Role/Department (with assignment_type, is_primary, effective dates) | `user.action` |
| **Users** | `DELETE`| `/api/v1/users/{id}/roles/{role_id}` | Remove one Role from a user | `user.action` |
| **RBAC** | `GET` | `/api/v1/rbac/roles` | List all Roles / Departments | `roles_permissions.view` |
| **RBAC** | `POST` | `/api/v1/rbac/roles` | Create new Role / Department (with optional `code` and `parent_department_id`) | `roles_permissions.create` |
| **RBAC** | `PATCH` | `/api/v1/rbac/roles/{id}` | Update Role name/description/code/parent (with cycle detection) | `roles_permissions.action` |
| **RBAC** | `DELETE`| `/api/v1/rbac/roles/{id}` | Delete Role (with impact check) | `roles_permissions.action` |
| **RBAC** | `POST` | `/api/v1/rbac/roles/{id}/delete-with-reassignment` | Safe delete with user reassignment | `roles_permissions.action` |
| **RBAC** | `GET` | `/api/v1/rbac/roles/{id}/hierarchy` | Fetch connected parent and child departments | `roles_permissions.view` |
| **RBAC** | `POST` | `/api/v1/rbac/roles/{id}/parents` | Link an additional parent department (with cycle check) | `roles_permissions.action` |
| **RBAC** | `DELETE`| `/api/v1/rbac/roles/{id}/parents/{parent_id}` | Unlink a parent department | `roles_permissions.action` |
| **RBAC** | `POST` | `/api/v1/rbac/roles/{id}/children` | Link an additional child department (with cycle check) | `roles_permissions.action` |
| **RBAC** | `DELETE`| `/api/v1/rbac/roles/{id}/children/{child_id}` | Unlink a child department | `roles_permissions.action` |
| **RBAC** | `GET` | `/api/v1/rbac/permissions` | List all system permission codes | `roles_permissions.view` |
| **RBAC** | `PUT` | `/api/v1/rbac/users/{id}/permissions/bulk` | Save per-user direct permission overrides | `roles_permissions.action` |
| **RBAC** | `GET` | `/api/v1/rbac/users/{id}/effective-permissions` | Compute effective user permissions | `roles_permissions.view` |
| **Positions** | `GET/POST`| `/api/v1/positions` | Manage positions/designations | `position.*` |
| **Positions** | `GET` | `/api/v1/positions/holders-for-user/{user_id}` | List position assignments held by a user | `position.view` |
| **Positions** | `POST/DELETE`| `/api/v1/positions/assignments[/{id}]` | Assign/remove an employee's position assignment | `position.update` |
| **Reporting** | `POST` | `/api/v1/reporting` | Create a reporting relationship (rejects self/circular reporting, 409) | `reporting.manage` |
| **Reporting** | `GET` | `/api/v1/reporting/managers/{user_id}` | List managers for a user | `reporting.view` |
| **Reporting** | `GET` | `/api/v1/reporting/direct-reports/{user_id}` | List direct reports for a user | `reporting.view` |
| **Reporting** | `DELETE`| `/api/v1/reporting/{id}` | Remove a reporting relationship | `reporting.manage` |
| **Reporting** | `POST` | `/api/v1/reporting/reassign-direct-reports/{manager_id}` | Move a manager's active direct reports to someone else | `reporting.manage` |
| **Reporting** | `POST` | `/api/v1/reporting/set-manager/{employee_id}` | Set or move an employee's primary manager (drag-and-drop org chart) | `reporting.manage` |
| **Reporting** | `GET` | `/api/v1/reporting/org-chart` | Dynamic organization chart data (active PRIMARY_REPORTING edges) | `reporting.view` |
| **Masters** | `GET/POST`| `/api/v1/masters/brands` | Manage product brands | `brand.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/categories` | Manage product categories | `category.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/subcategories` | Manage product sub-categories | `subcategory.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/countries` | Manage country records | `country.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/states` | Manage state/province records | `state.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/cities` | Manage city records | `city.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/currencies` | Manage currencies & conversion rates | `currency.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/uom` | Manage units of measurement | `uom.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/hsn` | Manage HSN/SAC customs codes | `hsn.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/company-list` | Manage enterprise company/branch entities | `organizationlist.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/supplier-types` | Manage supplier classification types | `suppliertype.*` |
| **Masters** | `GET/POST`| `/api/v1/masters/buyer-types` | Manage buyer client classification types | `buyertype.*` |
| **Search**  | `GET` | `/api/v1/search` | Universal global topbar search across all modules | Authenticated |
| **Products**| `GET` | `/api/v1/products` | Paginated product catalog | `product.read` |
| **Products**| `POST` | `/api/v1/products` | Create product record | `product.create` |
| **Products**| `PATCH` | `/api/v1/products/{id}` | Update product & technical specs | `product.update` |
| **Products**| `GET` | `/api/v1/products/{id}/datasheet-pdf` | Generate ReportLab PDF datasheet | `product.read` |
| **Suppliers**| `GET` | `/api/v1/suppliers` | List suppliers with multi-column sort | `supplier.read` |
| **Suppliers**| `POST` | `/api/v1/suppliers` | Create supplier record | `supplier.create` |
| **Suppliers**| `PATCH` | `/api/v1/suppliers/{id}` | Update supplier profile & bank details | `supplier.update` |
| **Suppliers**| `POST` | `/api/v1/suppliers/{id}/contacts` | Add contact to supplier directory | `supplier.update` |
| **Suppliers**| `POST` | `/api/v1/suppliers/import` | Bulk import suppliers from spreadsheet | `supplier.import` |
| **Suppliers**| `GET` | `/api/v1/suppliers/export` | Export supplier database | `supplier.export` |
| **Buyers** | `GET` | `/api/v1/buyers` | List buyer clients with status filters | `buyer.read` |
| **Buyers** | `POST` | `/api/v1/buyers` | Create buyer profile | `buyer.create` |
| **Buyers** | `PATCH` | `/api/v1/buyers/{id}` | Update buyer profile & credit limit | `buyer.update` |
| **Buyers** | `POST` | `/api/v1/buyers/{id}/addresses` | Add billing/shipping address | `buyer.update` |
| **Inquiries**| `GET` | `/api/v1/inquiries` | List RFQs with status filtering & financials | `inquiry.read` |
| **Inquiries**| `POST` | `/api/v1/inquiries` | Create new inquiry consignment | `inquiry.create` |
| **Inquiries**| `PATCH` | `/api/v1/inquiries/{id}` | Update inquiry header & status | `inquiry.update` |
| **Inquiries**| `POST` | `/api/v1/inquiries/{id}/items` | Add line item to inquiry | `inquiry.update` |
| **Inquiries**| `POST` | `/api/v1/inquiries/{id}/items/bulk` | Bulk add items to inquiry | `inquiry.update` |
| **Inquiries**| `POST` | `/api/v1/inquiries/{id}/bulk-rfqs` | Dispatch multi-item RFQ emails/WeChat to suppliers | `inquiry.action` |
| **Inquiries**| `GET`  | `/api/v1/inquiries/{id}/messages` | Fetch chronological two-way communication feed | `inquiry.read` |
| **Inquiries**| `GET`  | `/api/v1/inquiries/wechat/callback` | Tencent WeCom handshake verification | Public (Signature Verified) |
| **Inquiries**| `POST` | `/api/v1/inquiries/wechat/callback` | WeCom webhook handler with AI quotation ingestion | Public (AES Decrypted) |
| **Inquiries**| `POST` | `/api/v1/inquiries/items/{item_id}/rfqs` | Dispatch single-item RFQ email & portal link | `inquiry.action` |
| **Inquiries**| `POST` | `/api/v1/inquiries/items/{item_id}/quotations` | Manually record supplier quotation | `inquiry.update` |
| **Inquiries**| `PATCH` | `/api/v1/inquiries/quotations/{id}` | Edit quotation details (qty, price, currency, terms) | `inquiry.update` |
| **Inquiries**| `PATCH` | `/api/v1/inquiries/quotations/{id}/status` | Approve or reject quotation | `inquiry.approve` |
| **Inquiries**| `DELETE` | `/api/v1/inquiries/quotations/{id}` | Soft-delete quotation & resync KPIs | `inquiry.delete` |
| **Inquiries**| `POST` | `/api/v1/inquiries/inbound-webhook` | Inbound webhook for WeChat/Email auto-ingestion | Public (API / Webhook) |
| **Inquiries**| `GET` | `/api/v1/inquiries/items/{item_id}/quotations` | List quotations with turnaround & lead times | `inquiry.read` |
| **Inquiries**| `GET` | `/api/v1/inquiries/quotations/documents` | Fetch all quotation sheets for Gallery | `inquiry.read` |
| **Inquiries**| `POST` | `/api/v1/inquiries/bulk-tally-post` | Bulk mark items as Tally Entry Posted | `inquiry.update` |
| **Public** | `GET` | `/api/v1/public/quotes/{token}` | Fetch RFQ specifications for vendor | Public (Token Validated) |
| **Public** | `POST` | `/api/v1/public/quotes/{token}` | Submit vendor quote bids & lead times | Public (Token Validated) |
| **Public** | `POST` | `/api/v1/public/quotes/{token}/upload` | Upload quotation PDF / datasheet | Public (Token Validated) |
| **Planning**| `GET` | `/api/v1/planning/sheets` | List planning sheets / branches | `planning.read` |
| **Planning**| `POST` | `/api/v1/planning/sheets` | Create planning sheet | `planning.sheet.manage` |
| **Planning**| `GET` | `/api/v1/planning/sheets/{id}/grid` | Fetch dynamic planning matrix | `planning.read` |
| **Planning**| `GET` | `/api/v1/planning/sheets/{id}/filter-values` | Query distinct column filter values & counts | `planning.read` |
| **Planning**| `GET` | `/api/v1/planning/organization-search` | Search items across all branch sheets of an organization | `planning.read` |
| **Planning**| `POST` | `/api/v1/planning/rows` | Add item row to planning sheet | `planning.row.manage` |
| **Planning**| `POST` | `/api/v1/planning/columns` | Add dynamic column to sheet | `planning.column.manage` |
| **Planning**| `PATCH` | `/api/v1/planning/cells` | Update cell value & status color | `planning.cell.edit` |
| **Planning**| `POST` | `/api/v1/planning/container-calc` | Compute container CBM & load capacity | `planning.read` |
| **Audit** | `GET` | `/api/v1/audit` | Query immutable audit change logs | `audit.view` |
| **Trash** | `GET` | `/api/v1/trash` | List soft-deleted records | `trash.view` |
| **Trash** | `POST` | `/api/v1/trash/{entity}/{id}/restore` | One-click restore deleted record | `trash.restore` |
| **Trash** | `DELETE`| `/api/v1/trash/{entity}/{id}/purge` | Permanently purge record | `trash.purge` (Super Admin) |
| **Cache** | `GET` | `/api/v1/cache/stats` | Inspect cache metrics & hit rate | `settings.manage` |
| **Cache** | `DELETE`| `/api/v1/cache/flush` | Flush entire cache | `settings.manage` |
| **Organizations** | `GET/PATCH` | `/api/v1/organizations/profile` | Manage enterprise company profile & logo | `organization.view/manage` |
| **Events** | `WS` | `/api/v1/events/ws` | Real-time WebSocket connection bus | Authenticated |

---

## 14. Developer & AI Integration Guide (Rules of Engagement)

When building new features, modifying endpoints, or merging external components into this ERP:

### 14.1. Adding a New Business Module
1. **Model**: Create `backend/app/<module>/models.py`. Inherit from `Base`, `UUIDPrimaryKeyMixin`, `TimestampMixin`, `SoftDeleteMixin`, and `VersionMixin`.
2. **Schemas**: Define `Create`, `Update`, `Read` schemas in `backend/app/<module>/schemas.py`.
3. **Repository**: Inherit from `BaseRepository[Model]` in `backend/app/<module>/repository.py`.
4. **Service**: Implement business rules and audit recording in `backend/app/<module>/service.py`.
5. **Routes**: Wire endpoints with `Depends(require_permission("<module>.<action>"))` in `backend/app/<module>/routes.py`.
6. **Register Router**: Include the router in `backend/app/api/v1/router.py`.
7. **Migration**: Generate migration via `alembic revision --autogenerate -m "add <module> table"`.
8. **Frontend**: Create `frontend/src/pages/<Module>.tsx` and register route in `frontend/src/lib/nav.ts`.
9. **Living Documentation**: Update `doc/SYSTEM_DOCUMENTATION.md` immediately per [`AGENTS.md`](file:///c:/Users/Inhyma%20Solutions/Downloads/ERP_Main_Claude-main/AGENTS.md).

### 14.2. Antipatterns & Critical Rules
- ❌ **NEVER execute physical deletion (`session.delete(row)`) in standard flows**: Always use soft-delete (`row.deleted_at = utcnow()`).
- ❌ **NEVER bypass permission dependencies**: Every private endpoint must specify `Depends(require_permission(...))`.
- ❌ **NEVER alter database tables manually**: Keep all migrations version-controlled in `backend/alembic/versions/`.
- ❌ **NEVER modify user permissions without invalidating cache**: Always call `cache_manager.invalidate_user_permissions(user_id)`.

---

## 15. Deployment, Environment Variables & Operations

### Backend Environment Variables (`backend/.env`)
```env
# Application Settings
APP_NAME=Enterprise ERP
ENVIRONMENT=production
DEBUG=false
SECRET_KEY=your-super-secret-key-32-chars-minimum
API_V1_PREFIX=/api/v1

# Database Configuration
DATABASE_URL=postgresql+asyncpg://postgres:password@localhost:5432/erp_database

# CORS Allowed Origins
BACKEND_CORS_ORIGINS=["http://localhost:5173","https://erp.yourdomain.com"]

# JWT Configuration
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7

# Caching Configuration
REDIS_URL=redis://localhost:6379/0

# AI Quotation Extractor API Keys
OPENAI_API_KEY=your-openai-api-key
GEMINI_API_KEY=your-gemini-api-key

# Inbound Email Worker (IMAP)
IMAP_SERVER=imap.gmail.com
IMAP_PORT=993
IMAP_USERNAME=quotes@yourdomain.com
IMAP_PASSWORD=your-app-password
# Supabase Storage & Cloud Asset Persistence
SUPABASE_PROJECT_ID=mpvzjzunkiqchhhvxrza
SUPABASE_SERVICE_KEY=your-supabase-service-role-secret-key
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_URL=https://mpvzjzunkiqchhhvxrza.supabase.co
```

### Frontend Environment Variables (`frontend/.env`)
```env
VITE_API_BASE_URL=http://localhost:8000/api/v1
VITE_WS_BASE_URL=ws://localhost:8000/api/v1/events/ws
```

### Supabase Storage & Media Asset Persistence Architecture
- **Central Storage Engine (`app.common.storage`)**: All file and media uploads (Product Photos, Supplier Visit Photos/Videos, and Inbound Supplier Quotation Sheets/PDFs) utilize a unified async storage engine.
- **Dedicated Public Buckets**:
  - `product-images`: Multi-photo product catalogs and cover images.
  - `supplier-media`: Factory visit photos, videos, and supplier profile attachments.
  - `quotations`: PDF quote sheets and specification attachments extracted from supplier reply emails.
- **Automatic Bucket Provisioning**: The service role secret key automatically provisions public buckets (`public: true`, 50MB per-file ceiling) upon initial upload.
- **Resilient Fallback**: If Supabase credentials are not supplied or the remote service is temporarily unreachable, files safely persist to the backend's local `uploads/` directory with detailed structured warning logs.
- **Sync & Maintenance Utility (`scripts/sync_uploads_to_supabase.py`)**: One-command synchronization tool that scans local disk directories (`uploads/products`, `uploads/suppliers`, `uploads/quotations`), uploads them to Supabase Storage, and updates all existing PostgreSQL database references with global public URLs.

### Inbound & Outbound Email Architecture (Zero Wasted API Costs)
- **Bidirectional Mailbox Polling**: Poller inspects both `INBOX` and `[Gmail]/Sent Mail` to capture supplier replies and salesperson outbound negotiations sent directly via email clients (e.g. Gmail web, Outlook, mobile).
- **Outbound Multi-Recipient Parsing**: Outbound emails parse all addresses from `To` and `Cc` to guarantee matching against all recipient suppliers.
- **Outbound Company Emails**: Emails sent by Yinglima (`om1inhyma@gmail.com`) are strictly tagged as `direction="outbound"`. They are logged into the `Emails` tab timeline with **0 OpenAI API calls** and never create quotation rows.
- **First Valid Supplier Reply**: The first valid reply from a supplier to our RFQ triggers OpenAI GPT extraction **exactly ONCE**, creating `QT-AUTO-01`, uploading any quote attachment directly to Supabase Storage, and logging the email in the `Emails` tab.
- **Subsequent Follow-ups & Negotiations**: Once `QT-AUTO-01` exists for `(inquiry_item_id, supplier_id)`, all subsequent negotiation emails, price discussions, and delivery conversations bypass AI extraction (**0 OpenAI API calls**) and are appended directly to the `Emails` timeline.
- **Thread-Aware Item Inheritance**: Short follow-up emails without explicit SKU numbers automatically inherit the product item (`inquiry_item_id`) from the active thread history with that supplier.
- **Dynamic Live Polling**: Frontend automatically live-syncs quotes and email messages every 2.5 seconds, ensuring updates reflect instantly without manual browser refresh.
### Universal Search & Deep-Linking Architecture (`GET /search?q=`)
- **Global Search Endpoint (`app.search.service`)**: Searches asynchronously across Organization, Users, Suppliers, Buyers, Products, Product Categories & Sub-Categories, Brands, HSN Codes, Geography Masters (Countries, States, Cities), Currencies & UOM, **Inquiries & Consignments** (`ConsignmentCode`, `InquiryItem`), and **Trash** (soft-deleted records across all models via `MODEL_MAP`).
- **Client-Side Deep-Linking (`UniversalSearch.tsx`)**: Clicking a search result carries the matched record's UUID via query parameter (e.g. `/suppliers?id=8973e972-...`, `/buyers?id=...`, `/masters/products?id=...`, `/users?id=...`, `/inquiries?buyerId=...&inquiryId=...`, `/trash?q=...`).
- **Automatic Drawer & Modal Invocation**: Destination pages (`Suppliers.tsx`, `Buyers.tsx`, `Users.tsx`, `masters/Products.tsx`, `Inquiries.tsx`, `Trash.tsx`, and `MasterPage.tsx` for shared masters) detect parameters on mount or route transition and open corresponding views/drawers automatically.

### Global Paste Auto-Clean Sanitizer (`lib/pasteSanitizer.ts`)
- **System-Wide Clipboard Interceptor**: Listens globally to all paste events on HTML `<input>` and `<textarea>` elements across all forms, tables, search bars, and modals.
- **Artifact Stripping**: Automatically strips leading and trailing spaces, tab characters (`\t`), newlines (`\n`), and non-breaking space characters (`\u00A0`) captured when copying cells from Excel, PDFs, or web tables.
- **Native React State Dispatch**: Seamlessly triggers React's synthetic `onChange` and `input` events so form state updates immediately without manual backspacing. Excludes password and file upload inputs.

---
*Maintained and verified for Inhyma Solutions Enterprise ERP. Last updated: September 2, 2026 (Organization, Employee & Identity/Access Management upgrade: multi-role assignment, Employee directory, Departments/Positions/Leadership/Reporting Structure, dynamic Organization Chart -- see section 8.14).*