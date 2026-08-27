# Enterprise ERP System — Comprehensive Architecture & Feature Documentation

> **Version:** 1.0.0 (Production)  
> **Last Updated:** August 2026   
> **Architecture Style:** Decoupled Async REST API (FastAPI) + Single Page Application (React / Vite) with Real-Time WebSockets.

---

## Table of Contents

1. [System Overview & Architecture](#1-system-overview--architecture)
2. [Technology Stack](#2-technology-stack)
3. [Database Architecture & Data Models](#3-database-architecture--data-models)
4. [Security, Authentication & Session Engine](#4-security-authentication--session-engine)
5. [Role-Based Access Control (RBAC) & Departments](#5-role-based-access-control-rbac--departments)
6. [Module-by-Module Feature Breakdown](#6-module-by-module-feature-breakdown)
   - 6.1. [Authentication & Account Management](#61-authentication--account-management)
   - 6.2. [Users & HR Profile Management](#62-users--hr-profile-management)
   - 6.3. [Departments & Permissions (RBAC)](#63-departments--permissions-rbac)
   - 6.4. [Master Data & Configurations](#64-master-data--configurations)
   - 6.5. [Product Catalog & Specification Builder](#65-product-catalog--specification-builder)
   - 6.6. [Supplier Management & Public Quote Portal](#66-supplier-management--public-quote-portal)
   - 6.7. [Buyer & Client Management](#67-buyer--client-management)
   - 6.8. [Inquiries, RFQs & AI Quotation Extraction](#68-inquiries-rfqs--ai-quotation-extraction)
   - 6.9. [Shipment Planning & Container Optimization](#69-shipment-planning--container-optimization)
   - 6.10. [Audit Trails & Change Logging](#610-audit-trails--change-logging)
   - 6.11. [Recycle Bin (Trash & Recovery Engine)](#611-recycle-bin-trash--recovery-engine)
   - 6.12. [Organization & Global Settings](#612-organization--global-settings)
7. [Real-Time WebSocket & Event Synchronization](#7-real-time-websocket--event-synchronization)
8. [Multi-Tier Caching System](#8-multi-tier-caching-system)
9. [Bulk Data Import & Export Engine](#9-bulk-data-import--export-engine)
10. [API Route Directory & Endpoints](#10-api-route-directory--endpoints)
11. [Frontend Code Structure & Component Map](#11-frontend-code-structure--component-map)
12. [Deployment & Environment Configuration](#12-deployment--environment-configuration)

---

## 1. System Overview & Architecture

The Enterprise Resource Planning (ERP) platform is a high-performance, modular enterprise web platform designed for international manufacturing, trade, sourcing, supply chain planning, and multi-department governance.

```
+---------------------------------------------------------------------------------------+
|                                    CLIENT LAYER                                       |
|  React 18 SPA (TypeScript + Vite)  |  IHM Design System  |  WebSocket Live Listener   |
+-------------------------------------------+-------------------------------------------+
                                            | (HTTPS / WSS JSON API)
+-------------------------------------------v-------------------------------------------+
|                               FASTAPI APPLICATION LAYER                               |
|  +---------------------+  +---------------------+  +-------------------------------+  |
|  | Authentication &    |  | Role-Based Access   |  | Inquiries & AI Quote Engine   |  |
|  | Session Security    |  | Control (RBAC)      |  | (Gemini / Claude Vision / LLM)|  |
|  +---------------------+  +---------------------+  +-------------------------------+  |
|  | Master Data &       |  | Sourcing, Buyers &  |  | Container & Shipment          |  |
|  | Product Catalogs    |  | Suppliers Engine    |  | Planning Calculator           |  |
|  +---------------------+  +---------------------+  +-------------------------------+  |
|  | Audit Trail Engine  |  | Universal Soft      |  | Background Email Poller       |  |
|  | & Change Diffing    |  | Delete & Recycle    |  | & Inbound Parser              |  |
|  +---------------------+  +---------------------+  +-------------------------------+  |
+--------------------+----------------------+--------------------+----------------------+
                     |                      |                    |
+--------------------v----+  +--------------v-----+  +-----------v------------+
|   DATABASE LAYER        |  |    CACHE LAYER     |  |     STORAGE LAYER      |
| PostgreSQL / SQLite     |  | In-Memory & Redis  |  | Local / Cloud Uploads  |
| (SQLAlchemy 2.0 Async)  |  | Fallback Engine    |  | (PDFs, Images, Quotes) |
+-------------------------+  +--------------------+  +------------------------+
```

### Key Architectural Principles
1. **Async-First Execution**: The backend runs purely asynchronous I/O using Python `asyncio` and `asyncpg`/`aiosqlite` through SQLAlchemy 2.0 async sessions.
2. **Strict RBAC & Least Privilege**: Every endpoint enforces granular permission checks (`<module>.<action>.<scope>`). Direct user-level overrides allow surgical permission grants or denials on top of departmental assignments.
3. **Optimistic Locking & Concurrency Control**: Models implement `VersionMixin` (version counter) to detect concurrent modifications and prevent dirty overwrites.
4. **Non-Destructive Operations (Soft Delete)**: Entities inherit `SoftDeleteMixin` (`deleted_at`, `deleted_by`). No customer, transaction, or configuration data is lost upon deletion; records move to the Trash bin for full restoration or administrative audit.
5. **Real-Time Live Collaboration**: A global WebSocket connection manager broadcasts entity mutations across active browser sessions, ensuring data consistency across tabs without polling.

---

## 2. Technology Stack

### Backend Technologies
| Component | Technology | Description |
| :--- | :--- | :--- |
| **Framework** | FastAPI (Python 3.11+) | High-speed, async Python web API framework with automatic OpenAPI/Swagger generation |
| **ORM & Database** | SQLAlchemy 2.0 (Async) | Declarative ORM with explicit relationships, eager joins, and migration safety |
| **Migrations** | Alembic | Version-controlled, reproducible database schema migrations |
| **Authentication** | PyJWT & Argon2-cffi | Cryptographically secure JWT tokens (access + refresh) with Argon2id password hashing |
| **Validation** | Pydantic v2 | High-throughput schema serialization, parsing, and type validation |
| **Caching** | Redis / InMemoryCache | Multi-backend cache with namespace-based invalidation |
| **AI Integration** | Google Generative AI (Gemini) / Anthropic Claude | Automated supplier quotation parsing from PDFs, spreadsheets, and emails |
| **Background Tasks** | Asyncio Background Workers | Email IMAP poller, cache sweeps, and quotation extractor queue |
| **File Generation** | ReportLab & OpenPyXL | High-resolution PDF datasheets, comparison exports, and Excel workbooks |

### Frontend Technologies
| Component | Technology | Description |
| :--- | :--- | :--- |
| **Framework** | React 18 (TypeScript) | Declarative UI framework with functional hooks and strict typing |
| **Build Tool** | Vite | Lightning-fast HMR and optimized production bundling |
| **Styling** | Vanilla CSS (IHM Design System) | Modern, responsive CSS design tokens (glassmorphism, vibrant badges, accessible inputs) |
| **Data Parsing** | SheetJS (XLSX) & PapaParse | Client-side spreadsheet parsing and CSV generation for import/export wizards |
| **Networking** | Custom Fetch Client & WebSocket | Type-safe REST client with automatic token refreshing, queue locks, and live socket client |

---

## 3. Database Architecture & Data Models

The database models are structured under `backend/app/` using shared base mixins defined in `backend/app/database/base.py`:
- `UUIDPrimaryKeyMixin`: Generates RFC 4122 v4 UUID identifiers.
- `TimestampMixin`: Tracks `created_at` and `updated_at` in timezone-aware UTC.
- `SoftDeleteMixin`: Manages `deleted_at` and `deleted_by` for full lifecycle recovery.
- `VersionMixin`: Integer `version` column incremented on every update for optimistic locking.

### Core Entity Relationships

```mermaid
erDiagram
    USERS ||--o{ USER_ROLES : has
    ROLES ||--o{ USER_ROLES : assigned
    ROLES ||--o{ ROLE_PERMISSIONS : grants
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : defines
    USERS ||--o{ USER_PERMISSIONS : overrides
    PERMISSIONS ||--o{ USER_PERMISSIONS : applies
    USERS ||--o{ SESSIONS : establishes
    
    USERS ||--o{ INQUIRIES : creates
    INQUIRIES ||--o{ INQUIRY_ITEMS : contains
    INQUIRIES ||--o{ INQUIRY_SUPPLIER_QUOTES : receives
    SUPPLIERS ||--o{ INQUIRY_SUPPLIER_QUOTES : submits
    
    PRODUCTS ||--o{ INQUIRY_ITEMS : referenced_in
    CATEGORIES ||--o{ SUB_CATEGORIES : contains
    SUB_CATEGORIES ||--o{ PRODUCTS : categorizes
    BRANDS ||--o{ PRODUCTS : produces
    
    BUYERS ||--o{ BUYER_CONTACTS : has
    BUYERS ||--o{ INQUIRIES : requests
    SUPPLIERS ||--o{ SUPPLIER_CONTACTS : has
    
    INQUIRY_ITEMS ||--o{ SHIPMENT_PLANNING_ITEMS : transitions_to
```

---

## 4. Security, Authentication & Session Engine

**Location:** `backend/app/auth/` & `frontend/src/lib/authContext.tsx`

### 1. Dual-Token Architecture
- **Access Token**: Short-lived JWT (default 15 minutes) containing `sub` (User UUID), `username`, `roles`, and initial permissions.
- **Refresh Token**: Long-lived secure token stored securely in the database (`refresh_tokens` table) with single-use rotation, expiration enforcement, and instant blacklisting upon logout.

### 2. Password Security & Argon2id
- Passwords are encrypted using Argon2id with salt generation and configurable time/memory costs.
- **Password History**: Prevents users from reusing their last $N$ passwords (`password_histories` table).
- **Temporary Passwords**: Generated cryptographically during admin creation or reset. Automatically forces `must_change_password=True` on subsequent login.

### 3. Brute-Force Protection & Lockout
- Failed login attempts are recorded (`failed_login_count`).
- Exceeding the maximum threshold locks the account (`locked_until`) and records an audit log.

### 4. Active Session Governance
- Every login creates a session record (`sessions` table) storing:
  - User ID & Refresh Token ID
  - IP Address & Country/Location
  - Browser User-Agent & Device Type
  - Last Activity Timestamp
- Users and administrators can inspect active sessions on `Profile.tsx` and `Users.tsx` and selectively revoke suspicious devices or perform a global "Logout Everywhere".

---

## 5. Role-Based Access Control (RBAC) & Departments

**Location:** `backend/app/rbac/`, `frontend/src/pages/Rbac.tsx`, `frontend/src/pages/EffectivePermissions.tsx`

The platform utilizes a multi-tiered permission system that treats **Departments** as functional role bundles, while providing individual user-level fine-tuning.

```
+-------------------------------------------------------------------------------+
|                             DEPARTMENT BASE ROLES                             |
|          (e.g., Sales, Planning, Procurement, Quality, Logistics)            |
|                     Assigned to all department members.                       |
+---------------------------------------+---------------------------------------+
                                        | (Inherited)
+---------------------------------------v---------------------------------------+
|                    DEPARTMENT MANAGERS & DIRECT OVERRIDES                     |
|  +-------------------------------------------------------------------------+  |
|  | + EXTRA GRANTS : Specific additional permissions (e.g., delete, export) |  |
|  | x DIRECT DENIES: Specific revocations overriding departmental defaults  |  |
|  +-------------------------------------------------------------------------+  |
+---------------------------------------+---------------------------------------+
                                        | (Calculated)
+---------------------------------------v---------------------------------------+
|                         FINAL EFFECTIVE PERMISSIONS                           |
|       Computed at runtime & embedded in authorization dependency gate.        |
+-------------------------------------------------------------------------------+
```

### Key Capabilities
- **Department Permissions Matrix**: Intuitive checkbox grid categorized by module, with select-all and deselect-all per group.
- **Managers in Department**: Designate department heads and managers. Managers display a prominent `MANAGER` badge and allow direct access to their individual permission overrides drawer (`🔑 Edit permissions`).
- **Reporting Hierarchy**: Automatically syncs department managers with reporting members (`User.manager_id`).
- **Clone Department Permissions**: Clones an entire permission profile from a source department to a target department with duplicate validation.
- **Safe Department Deletion & User Reassignment**: When deleting a department that currently contains members, the system prompts the administrator to reassign all affected users to a fallback department (defaults to `User`), preventing orphaned accounts.

---

## 6. Module-by-Module Feature Breakdown

### 6.1. Authentication & Account Management
- **Files**: `backend/app/auth/routes.py`, `backend/app/auth/service.py`, `frontend/src/pages/Login.tsx`, `frontend/src/pages/Profile.tsx`
- **Features**:
  - Secure login with email/username and password.
  - Profile viewer and self-service password update.
  - Active login sessions manager with individual device revocation.
  - Live permission viewer displaying the current user's active permissions.

### 6.2. Users & HR Profile Management
- **Files**: `backend/app/users/routes.py`, `backend/app/users/service.py`, `frontend/src/pages/Users.tsx`
- **Features**:
  - Employee directory with pagination, multi-field search, status filtering, and sorting.
  - Complete HR profile: Employee Code, Contact Numbers, Gender, Date of Birth, Date of Joining, Employment Type (Full-Time, Part-Time, Contract, Intern), Employment Status, Address, and Emergency Contacts.
  - Reporting Manager assignment with hierarchical lookup.
  - User Action Menu:
    - 👁️ **View Details**: Full profile breakdown, assigned departments, and live sessions.
    - ✏️ **Edit Profile**: Modify non-credential profile attributes.
    - 🔑 **Reset Password**: Generate one-time temporary passwords.
    - 🛡️ **Assign Department**: Update primary department.
    - 🔑 **Manage Permission Overrides**: Slide-over drawer to configure direct user-level grants and denials.

### 6.3. Departments & Permissions (RBAC)
- **Files**: `backend/app/rbac/routes.py`, `backend/app/rbac/service.py`, `frontend/src/pages/Rbac.tsx`
- **Features**:
  - Department list with system protection indicators (Admin and User system roles are protected).
  - Dedicated Department Manager card with live member counter and reporting manager synchronization.
  - Granular permission assignment by business module.
  - Role cloning and safe deletion with user reassignment modal.

### 6.4. Master Data & Configurations
- **Files**: `backend/app/masters/`, `frontend/src/pages/masters/`
- **Sub-Modules**:
  1. **Brands (`Brands.tsx`)**: Global brand directory linked to products and suppliers.
  2. **Product Categories & Sub-Categories (`Categories.tsx`, `SubCategories.tsx`)**: Multi-level hierarchical categorization.
  3. **Geography (`Countries.tsx`, `States.tsx`, `Cities.tsx`)**: Global location records with cascading relationships and dial code lookups.
  4. **Currencies & Exchange Rates (`Currencies.tsx`)**: Multi-currency configuration with ISO codes, symbols, and live conversion rate factors.
  5. **Units of Measurement (`Uom.tsx`)**: Standardized measurement units (kg, meters, pieces, sets, rolls).
  6. **HSN / SAC Codes (`Hsn.tsx`)**: Harmonized System codes for international taxation and customs compliance.
  7. **Business Entities (`CompanyList.tsx`)**: Internal legal operating entities.
  8. **Buyer & Supplier Classifications (`BuyerTypes.tsx`, `SupplierTypes.tsx`)**: Segmentations for vendor and client profiling.

### 6.5. Product Catalog & Specification Builder
- **Files**: `backend/app/masters/products_routes.py`, `frontend/src/pages/masters/Products.tsx`, `frontend/src/pages/ProductGallery.tsx`
- **Features**:
  - Product record management with SKU, Part Number, Category, Sub-Category, Brand, and HSN links.
  - **Dynamic Specification Builder**: Key-value technical specification engine allowing custom product attributes (e.g. Dimensions, Voltage, Speed, Material).
  - **Supplier Association**: Associate authorized suppliers with default purchase pricing and lead times.
  - **Media Gallery & Document Center**: Image uploads, technical PDF datasheets, and certificates.
  - **Visual Product Gallery (`ProductGallery.tsx`)**: Grid and card layout with live filtering by category, brand, and specifications.

### 6.6. Supplier Management & Public Quote Portal
- **Files**: `backend/app/suppliers/`, `frontend/src/pages/Suppliers.tsx`, `frontend/src/pages/PublicSupplierQuotePage.tsx`
- **Features**:
  - Complete vendor records: Corporate identity, Tax/TIN numbers, Address, Bank details, Certifications, Payment Terms, and Brands represented.
  - Multi-contact directory per supplier (Sales, Technical, Accounts).
  - Ascending and descending multi-column table sorting.
  - **Public Supplier Quotation Portal**: Generate secure, tokenized public links (`/quotes/public/:token`) allowing vendors to submit line-item bids, pricing, lead times, and quote attachments directly into the ERP without requiring a system account.
  - Bulk Import/Export wizard with automated validation and duplicate prevention.

### 6.7. Buyer & Client Management
- **Files**: `backend/app/buyers/`, `frontend/src/pages/Buyers.tsx`
- **Features**:
  - Comprehensive buyer profiles with client grade (A, B, C, Premium), credit limit, currency preferences, and payment terms.
  - Multi-address directory (Billing, Factory, Shipping, Warehouse).
  - Multi-contact directory with designation and direct communication channels.
  - Multi-column sortable table with status filters and Excel/CSV bulk import/export.

### 6.8. Inquiries, RFQs & AI Quotation Extraction
- **Files**: `backend/app/inquiries/`, `frontend/src/pages/Inquiries.tsx`, `backend/app/inquiries/quote_extractor.py`, `backend/app/inquiries/email_inbound.py`
- **Features**:
  - Complete Request for Quotation (RFQ) lifecycle tracking: `DRAFT` $\rightarrow$ `SENT_TO_SUPPLIERS` $\rightarrow$ `QUOTES_RECEIVED` $\rightarrow$ `UNDER_EVALUATION` $\rightarrow$ `APPROVED` $\rightarrow$ `ORDER_PLACED` $\rightarrow$ `CLOSED`.
  - Line-item specifications: Item name, description, target unit price, quantity, UOM, required delivery dates, and technical files.
  - **Quotation Comparison Matrix**: Side-by-side multi-vendor comparison table highlighting lowest bids, best lead times, and terms.
  - **AI Quotation Extractor Engine**:
    - Uses Google Gemini / Claude multimodal AI to automatically parse unstructured supplier quotation PDFs, scanned documents, Excel sheets, and email bodies into structured line-item bids.
  - **Automated Inbound Email Worker**:
    - Background task (`email_inbound.py`) connects via IMAP to monitor inquiry inboxes, match incoming emails to RFQs, download attachments, trigger AI extraction, and log quotation records automatically.

### 6.9. Shipment Planning & Container Optimization
- **Files**: `backend/app/planning/`, `frontend/src/pages/Planning.tsx`
- **Features**:
  - Bridges confirmed orders and sourcing lines into logistical shipment planning.
  - **Container Calculator**: Computes Total CBM (Cubic Meters), Gross Weight, Net Weight, and suggests container utilization (20FT, 40FT, 40FT HC, LCL).
  - **Milestone Tracking**: Production readiness, Pre-shipment Inspection (PSI), Container Stuffing, Bill of Lading (BL) issue, Customs Clearance, Port of Loading (POL), Port of Discharge (POD), and Final Delivery.
  - Group-wise subcategory & product sorting, multi-column sorting, and bulk updates.

### 6.10. Audit Trails & Change Logging
- **Files**: `backend/app/audit/`, `frontend/src/pages/Audit.tsx`
- **Features**:
  - Immutable audit logs capturing every creation, update, deletion, login, permission override, and bulk operation.
  - **Field-Level Diffing**: Stores before-and-after JSON snapshots showing exact attribute modifications.
  - Captures Actor (User ID, Name), IP Address, User-Agent, Action Type, Target Entity, and UTC Timestamp.
  - Filterable by date range, action type, user, and entity type.

### 6.11. Recycle Bin (Trash & Recovery Engine)
- **Files**: `backend/app/trash/`, `frontend/src/pages/Trash.tsx`
- **Features**:
  - Centralized repository of all soft-deleted records across all system modules (Suppliers, Buyers, Products, Inquiries, Planning items, Master records).
  - Displays original deletion timestamp and user who deleted the record.
  - **Single-Click Restore**: Instantly recovers deleted records back to active system views without breaking foreign-key references.
  - **Permanent Purge**: Restricted to Super Administrators for GDPR/compliance data destruction.

### 6.12. Organization & Global Settings
- **Files**: `backend/app/organizations/`, `frontend/src/pages/Organization.tsx`
- **Features**:
  - Enterprise profile management: Legal Name, Trade Name, Registration Numbers, Tax/VAT/GST IDs, Corporate Address, Official Contact, and Base Currency.
  - System-wide default configurations.

---

## 7. Real-Time WebSocket & Event Synchronization

**Location:** `backend/app/events/manager.py` & `frontend/src/lib/live/liveClient.ts`

To support high-concurrency multi-user environments without dirty overwrites:
1. When any client modifies a record (e.g. saves an inquiry, updates shipment planning, modifies a supplier), the backend publishes an event through `ConnectionManager`.
2. The WebSocket manager broadcasts a lightweight JSON payload containing `event_type`, `entity_type`, `entity_id`, and `updated_by_user_id`.
3. Client tabs receive the event and selectively refresh active tables or alert the user if another user is actively modifying the same record.

---

## 8. Multi-Tier Caching System

**Location:** `backend/app/cache/`

The caching engine (`CacheManager`) operates with a dual-backend strategy:
- **Redis Backend**: Used in distributed production environments.
- **InMemory Backend**: Zero-dependency high-speed fallback for local development or single-node deployments.

### Namespaces & TTL Configurations
- `permissions:<user_id>`: User permission set cache (invalidated immediately upon department or override changes).
- `dropdowns:<entity>`: Cached master dropdown datasets (Countries, Currencies, Categories, Brands).
- `dashboard:counts`: Cached dashboard aggregate metrics.
- `records:<entity>:<id>`: Hot-path entity lookup caching.

---

## 9. Bulk Data Import & Export Engine

**Location:** `frontend/src/components/ImportWizard.tsx`, `backend/app/common/importer.py`

### Import Workflow
```
[Select File (.xlsx / .csv)] 
       │
       ▼
[Auto-Detect & Map Columns] ───► [Column Mapping Override UI]
       │
       ▼
[Client-Side Validation & Duplicate Check]
       │
       ▼
[Batch Upload to API] ───► [Transactional Database Insertion]
       │
       ▼
[Import Summary & Error Log Report]
```

- Supports fuzzy column header matching (e.g., "Company Name", "Supplier", "vendor_name" $\rightarrow$ `name`).
- Detects existing duplicate records by TIN, Email, Phone, or Code.
- Provides downloadable error reports for failed rows.

---

## 10. API Route Directory & Endpoints

| Module | Route Prefix | Primary Operations |
| :--- | :--- | :--- |
| **Auth** | `/api/v1/auth` | `/login`, `/refresh`, `/logout`, `/sessions`, `/sessions/revoke` |
| **Users** | `/api/v1/users` | `/`, `/{id}`, `/{id}/roles`, `/{id}/reset-password`, `/profile` |
| **RBAC** | `/api/v1/rbac` | `/roles`, `/roles/{id}`, `/permissions`, `/users/{id}/permissions/bulk` |
| **Masters** | `/api/v1/masters` | `/brands`, `/categories`, `/subcategories`, `/countries`, `/states`, `/cities`, `/currencies`, `/uom`, `/hsn` |
| **Products** | `/api/v1/products` | `/`, `/{id}`, `/{id}/specs`, `/{id}/datasheet-pdf`, `/{id}/images` |
| **Suppliers** | `/api/v1/suppliers` | `/`, `/{id}`, `/{id}/contacts`, `/{id}/public-quote-link`, `/import`, `/export` |
| **Buyers** | `/api/v1/buyers` | `/`, `/{id}`, `/{id}/contacts`, `/{id}/addresses`, `/import`, `/export` |
| **Inquiries** | `/api/v1/inquiries` | `/`, `/{id}`, `/{id}/items`, `/{id}/quotes`, `/{id}/ai-extract-quote`, `/{id}/compare-matrix` |
| **Public Quotes** | `/api/v1/public/quotes` | `/{token}` (Submit quote, upload files, read RFQ details) |
| **Planning** | `/api/v1/planning` | `/items`, `/items/{id}`, `/items/bulk-update`, `/container-calc` |
| **Audit** | `/api/v1/audit` | `/`, `/{id}`, `/export` |
| **Trash** | `/api/v1/trash` | `/`, `/{entity_type}/{id}/restore`, `/{entity_type}/{id}/purge` |
| **Organization**| `/api/v1/organizations` | `/profile`, `/settings` |
| **Cache** | `/api/v1/cache` | `/stats`, `/keys`, `/flush`, `/clear-namespace` |

---

## 11. Frontend Code Structure & Component Map

```
frontend/src/
├── components/
│   ├── ui.tsx                 # Modal, Card, Button, Badge, Skeleton Loaders
│   ├── fields.tsx             # Accessible TextField, SelectField, CheckboxField
│   ├── AppShell.tsx           # Global responsive layout, sidebar, header, user menu
│   ├── ActionDropdown.tsx     # Context action menus for data tables
│   ├── Pagination.tsx         # Unified table pagination bar
│   ├── ImportWizard.tsx       # Universal spreadsheet import wizard modal
│   └── TableComponents.tsx    # Sortable table headers, empty rows, status badges
├── pages/
│   ├── Dashboard.tsx          # Analytics and metric overview
│   ├── Login.tsx              # Split-screen modern authentication portal
│   ├── Users.tsx              # User directory, HR profiles, and permission overrides
│   ├── Rbac.tsx               # Departments, Managers, and permission matrix
│   ├── EffectivePermissions.tsx# Live permission calculator & simulation tool
│   ├── Suppliers.tsx          # Supplier database with sorting, contacts, quote links
│   ├── Buyers.tsx             # Client management, multi-address directory
│   ├── Inquiries.tsx          # RFQs, quotation comparison, and AI quotation extraction
│   ├── Planning.tsx           # Shipment planning, container volume, milestone tracking
│   ├── ProductGallery.tsx     # Visual catalog with filter sidebar and specs viewer
│   ├── Audit.tsx              # System audit trails and change delta inspector
│   ├── Trash.tsx              # Recycle bin and record recovery center
│   ├── Organization.tsx       # Enterprise settings and configurations
│   ├── Profile.tsx            # Current user settings, password update, active sessions
│   ├── PublicSupplierQuotePage.tsx # Tokenized standalone vendor quote portal
│   └── masters/               # Master data management pages (Brands, Categories, etc.)
├── lib/
│   ├── api.ts                 # Type-safe API client with automatic token refreshing
│   ├── authContext.tsx        # React authentication context & session state
│   ├── nav.ts                 # Navigation route registry and permission mapping
│   ├── permissionLabels.ts    # Human-friendly labels for permission codes & modules
│   └── live/                  # Real-time WebSocket client and event dispatchers
└── styles/
    └── style.css              # IHM Design System CSS stylesheet
```

---

## 12. Deployment & Environment Configuration

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
GEMINI_API_KEY=your-gemini-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key

# Inbound Email Worker (IMAP)
IMAP_SERVER=imap.gmail.com
IMAP_PORT=993
IMAP_USERNAME=quotes@yourdomain.com
IMAP_PASSWORD=your-app-password
IMAP_POLL_INTERVAL_SECONDS=60
```

### Frontend Environment Variables (`frontend/.env`)
```env
VITE_API_BASE_URL=http://localhost:8000/api/v1
VITE_WS_BASE_URL=ws://localhost:8000/api/v1/events/ws
```

---
*Documented and verified by Antigravity IDE for Inhyma Solutions.*
