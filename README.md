# ERP System — Comprehensive Architecture & Execution Guide

A production-grade, modular-monolith enterprise resource planning (ERP) system built with **FastAPI**, **SQLAlchemy 2.x (async)**, **PostgreSQL (asyncpg + psycopg2)**, **Alembic**, and a lightweight, zero-build **HTML5/Vanilla JavaScript** admin dashboard.

---

## 📌 Table of Contents
1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [How to Run the Project (Quick Start)](#3-how-to-run-the-project-quick-start)
   - [Prerequisites](#prerequisites)
   - [Backend Setup & Launch](#step-1-backend-setup--launch)
   - [Frontend Setup & Launch](#step-2-frontend-setup--launch)
   - [Default Super Admin Credentials](#default-super-admin-credentials)
4. [Backend Deep Dive Architecture](#4-backend-deep-dive-architecture)
   - [Layered Onion Architecture](#layered-onion-architecture)
   - [Core Plumbing (`app/core`)](#core-plumbing-appcore)
   - [Database Layer (`app/database`)](#database-layer-appdatabase)
   - [Generic Components (`app/common`)](#generic-components-appcommon)
   - [Middlewares (`app/middleware`)](#middlewares-appmiddleware)
   - [Authentication & Security (`app/auth`)](#authentication--security-appauth)
   - [Role-Based Access Control (`app/rbac`)](#role-based-access-control-apprbac)
   - [Background Queue & Cache (`app/queue` & `app/cache`)](#background-queue--cache-appqueue--appcache)
   - [Feature Modules Breakdown](#feature-modules-breakdown)
5. [Frontend Deep Dive](#5-frontend-deep-dive)
6. [Git & GitHub Operations Notice](#6-git--github-operations-notice)

---

## 1. Project Overview

This ERP system features a **Modular Monolith** architecture:
- **Backend**: Python 3.11+ using FastAPI for async API routing, Pydantic v2 for request validation, SQLAlchemy 2.0 async for database interactions, Alembic for schema migrations, and Argon2/JWT for security.
- **Frontend**: Plain HTML, CSS, and vanilla JS (served staticaly via Python's HTTP server), communicating with backend REST endpoints under `/api/v1`.
- **Database**: PostgreSQL (compatible with hosted solutions like Supabase / Supabase PgBouncer pooler).

---

## 2. Repository Structure

```
ERP1/
├── README.md                 # Root documentation (this file)
├── backend/                  # FastAPI Backend API Service
│   ├── app/                  # Application Source Code
│   │   ├── api/v1/           # API router aggregator & health check
│   │   ├── audit/            # Comprehensive audit logging system
│   │   ├── auth/             # Authentication & Token management (Argon2, JWT)
│   │   ├── cache/            # In-memory LRU caching abstraction
│   │   ├── common/           # Base Repository, Base Service, Pagination helpers
│   │   ├── core/             # Settings, structured JSON logging, exception handling, response envelopes
│   │   ├── database/         # SQLAlchemy engine, session management, base ORM mixins
│   │   ├── departments/      # Department management module
│   │   ├── designations/     # Designation management module
│   │   ├── employees/        # Employee management module
│   │   ├── main.py           # Composition root (FastAPI app factory & lifespan)
│   │   ├── masters/          # Master Data (Products, Brands, Categories, Locations, Currencies, UOM, HSN)
│   │   ├── middleware/       # Request ID correlation, Access logging, Audit middleware
│   │   ├── notifications/    # Notification queue abstractions
│   │   ├── organizations/    # Organization/Company profile management
│   │   ├── queue/            # DB-backed background task worker & queue
│   │   ├── rbac/             # Roles, Permissions, User-Role assignments
│   │   ├── reports/          # Report generation infrastructure
│   │   ├── suppliers/        # Supplier master & management
│   │   └── users/            # User account management
│   ├── alembic/              # Database migration scripts
│   ├── scripts/              # Seed scripts (database bootstrapping)
│   ├── tests/                # Pytest test suite
│   ├── .env.example          # Environment variable template
│   ├── alembic.ini           # Migration configuration
│   ├── pytest.ini            # Test configuration
│   ├── requirements.txt      # Python dependencies
│   └── server.py             # One-command backend startup script
└── frontend/                 # Admin Web Interface (Static HTML/CSS/JS)
    ├── css/                  # Shared stylesheet styles
    ├── js/                   # Shared API helpers & authentication handling
    ├── audit.html            # Audit logs view
    ├── departments.html      # Department management UI
    ├── designations.html     # Designation management UI
    ├── employee-detail.html  # Detailed employee profile & management
    ├── employee-form.html    # Employee creation / edit form
    ├── employees.html        # Employee directory table
    ├── index.html            # Dashboard overview
    ├── login.html            # Login portal
    ├── masters-*.html        # Master data UI pages (Products, Brands, HSN, UOM, etc.)
    ├── organization.html     # Organization setup UI
    ├── rbac.html             # Role & Permission assignment UI
    ├── serve.py              # One-command frontend dev server
    └── suppliers.html        # Supplier directory & management UI
```

---

## 3. How to Run the Project (Quick Start)

### Prerequisites
- **Python**: Version 3.11 or higher installed on your system.
- **Database**: PostgreSQL server or Supabase connection string.

---

### Step 1: Backend Setup & Launch

1. Open your terminal and navigate to the `backend/` directory:
   ```bash
   cd backend
   ```

2. Create a Python Virtual Environment:
   - **Windows**:
     ```powershell
     python -m venv venv
     .\venv\Scripts\activate
     ```
   - **macOS / Linux**:
     ```bash
     python3 -m venv venv
     source venv/bin/activate
     ```

3. Install required packages:
   ```bash
   pip install -r requirements.txt
   ```

4. Configure Environment Variables:
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Open `.env` and verify/update `DATABASE_URL` and `JWT_SECRET_KEY`.

5. **Start Backend (One Command)**:
   ```bash
   python server.py
   ```
   *What `python server.py` automatically handles for you:*
   - Runs pending database migrations (`alembic upgrade head`).
   - Seeds initial database data (permissions, super admin role, admin user).
   - Launches the Uvicorn server on **`http://127.0.0.1:8000`** with hot-reloading enabled.
   - Interactive API docs available at: **`http://127.0.0.1:8000/docs`**.

---

### Step 2: Frontend Setup & Launch

1. Open a second terminal window and navigate to the `frontend/` directory:
   ```bash
   cd frontend
   ```

2. **Start Frontend Server (One Command)**:
   ```bash
   python serve.py
   ```
   *What `python serve.py` does:*
   - Starts a local HTTP server on **`http://localhost:5500`**.
   - Automatically opens your default web browser to **`http://localhost:5500/login.html`**.

---

### Default Super Admin Credentials

Upon initial database seeding, use the following credentials to sign in:
- **Username / Email**: `admin@example.com` (or `admin`)
- **Password**: `ChangeMe!12345`

---

## 4. Backend Deep Dive Architecture

### Layered Onion Architecture
The backend strictly isolates business logic and data access. Dependencies flow **downward only**:

$$\text{Routes (API)} \longrightarrow \text{Services (Business Logic)} \longrightarrow \text{Repositories (Database Queries)} \longrightarrow \text{SQLAlchemy Models}$$

- **Routes (`app/*/routes.py`)**: Handle HTTP requests/responses, input validation via Pydantic schemas, and permission dependencies.
- **Services (`app/*/service.py`)**: Implement business rules, workflow checks, transaction boundaries, domain exception handling.
- **Repositories (`app/*/repository.py`)**: Encapsulate all database access using SQLAlchemy 2.0 async queries.
- **Models (`app/*/models.py`)**: Declarative ORM models.

### Core Plumbing (`app/core`)
- **`config.py`**: Pydantic `BaseSettings` reading environment variables from `.env`. Validates production security keys on boot.
- **`responses.py`**: Standardized JSON envelope for **all** responses:
  ```json
  {
    "success": true,
    "data": { ... },
    "meta": { "page": 1, "total": 100 },
    "error": null
  }
  ```
- **`exceptions.py` & `exception_handlers.py`**: Clean separation between framework-agnostic domain exceptions (`NotFoundException`, `ConflictException`, `PermissionDeniedException`) and FastAPI error handling. Converts domain errors into standard HTTP envelopes automatically.

### Database Layer (`app/database`)
- **`engine.py`**: Creates the process-wide async SQLAlchemy engine (`asyncpg`). Supports connection pooling and PgBouncer connection tuning.
- **`session.py`**: Provides per-request `AsyncSession` dependency for FastAPI routes.
- **`base.py`**: Contains `DeclarativeBase` and reusable mixins:
  - `UUIDPrimaryKeyMixin`: Auto-generates UUID4 primary keys.
  - `TimestampMixin`: Automatically tracks `created_at` and `updated_at` timestamps in UTC.
  - `SoftDeleteMixin`: Includes `deleted_at` timestamp. `BaseRepository` automatically filters out soft-deleted records.

### Generic Components (`app/common`)
- **`base_repository.py`**: Generic Async CRUD repository providing `.get_by_id()`, `.list()`, `.create()`, `.update()`, `.soft_delete()`, and `.count()`.
- **`base_service.py`**: Generic service pattern mapping business calls to repository methods.
- **`pagination.py`**: Standard pagination parameters (`page`, `page_size`, `sort_by`, `sort_order`).

### Middlewares (`app/middleware`)
1. **`RequestIdMiddleware`**: Attaches a unique `X-Request-ID` UUID to every incoming request and correlates all log entries for that request.
2. **`AccessLogMiddleware`**: Log incoming HTTP requests and execution duration in structured JSON format.
3. **`AuditMiddleware`**: Captures state-changing requests (POST, PUT, PATCH, DELETE) and queues audit log records containing actor ID, IP address, user agent, action, and payload details.

### Authentication & Security (`app/auth`)
- **Password Security**: Argon2id hashing algorithm via `argon2-cffi`. Password policy enforces min length, uppercase, lowercase, numbers, special characters, password history, and max age.
- **JWT Tokens**: Dual token architecture (Short-lived Access Token, Long-lived Refresh Token). Decoded and verified via `pyjwt`.
- **Brute Force Protection**: Account lockout after consecutive failed attempts (`MAX_FAILED_LOGIN_ATTEMPTS`).

### Role-Based Access Control (`app/rbac`)
- **Permissions**: Granular system actions (e.g. `employees:read`, `employees:create`, `suppliers:delete`).
- **Roles**: Aggregations of permissions (e.g. `Super Admin`, `HR Manager`, `Inventory Clerk`).
- **User Role Mapping**: Many-to-Many association between users and roles.
- **Route Enforcer**: FastAPI dependency `require_permission("permission_code")` enforces authorization at API endpoints.

### Background Queue & Cache (`app/queue` & `app/cache`)
- **Background Queue (`app/queue`)**: Database-backed asynchronous job processing framework with automatic worker lifecycle, retries, and stuck-job recovery.
- **In-Memory Cache (`app/cache`)**: Thread-safe LRU cache with TTL support and background cleanup worker.

### Feature Modules Breakdown
1. **`organizations`**: Manages company master details (tax IDs, addresses, operational currency).
2. **`departments` & `designations`**: Organizational hierarchy and job titles.
3. **`employees`**: Full employee lifecycle, department transfers, manager assignments, status transitions.
4. **`masters`**: Core ERP master data lookups:
   - Location: `countries`, `states`, `cities`
   - Product Catalog: `brands`, `product_categories`, `product_sub_categories`, `products`
   - Financial & Standard Units: `currencies`, `uom` (Units of Measure), `hsn` (Harmonized System Nomenclature code)
5. **`suppliers`**: Supplier directory, contact info, tax compliance data, status management.
6. **`audit`**: Queryable log of administrative actions, resource modifications, and user logins.

---

### Database Schema & Table Reference (29 Tables)

The database schema is organized into 9 logical domains. Every table includes auto-generated **UUID primary keys**, **UTC timestamps** (`created_at`, `updated_at`), and automatic **Soft Deletion** (`deleted_at`) where applicable.

#### 1. Authentication & Security Domain
- **`users`**: User accounts storing hashed Argon2 credentials, `email`, `username`, `is_active`, `is_superuser`, `failed_login_attempts`, `locked_until`, `password_changed_at`.
- **`sessions`**: Active user session tokens, client IP, user agent, refresh token hash, expiration timestamps, and revocation status.
- **`token_blacklist`**: Deny-list of revoked JWT access tokens for instantaneous invalidation on logout.
- **`password_history`**: Stores past password hashes to prevent users from reusing recent passwords.

#### 2. Role-Based Access Control (RBAC) Domain
- **`permissions`**: Master registry of fine-grained permissions (`code`, `name`, `module`, `description`).
- **`roles`**: System & custom role definitions (`name`, `code`, `description`, `is_system_role`).
- **`role_permissions`**: Junction table mapping permissions to roles.
- **`user_roles`**: Junction table assigning roles to user accounts.

#### 3. Organization & HR Domain
- **`organizations`**: Singleton company master profile storing legal name, tax registration (GSTIN/VAT), address, contact email, and base currency ID.
- **`departments`**: Company departments (`code`, `name`, `description`, `parent_department_id` for hierarchy).
- **`designations`**: Job titles/levels (`code`, `title`, `level`, `department_id`).
- **`employees`**: HR Employee directory (`employee_code`, `first_name`, `last_name`, `email`, `phone`, `status`, `hire_date`, `department_id`, `designation_id`, `manager_id`, `user_id`).

#### 4. Location Master Data Domain
- **`countries`**: Country lookup table (`code` e.g. "IN", `name`, `phone_code`).
- **`states`**: State/province lookup table (`code`, `name`, `country_id`).
- **`cities`**: City lookup table (`name`, `state_id`).

#### 5. Product Catalog Master Data Domain
- **`brands`**: Product brand registry (`code`, `name`, `description`).
- **`product_categories`**: Top-level product classification (`code`, `name`, `description`).
- **`product_sub_categories`**: Second-level product classification (`code`, `name`, `category_id`).
- **`products`**: Master Item Catalog (`sku`, `name`, `description`, `brand_id`, `category_id`, `sub_category_id`, `uom_id`, `hsn_id`, `purchase_price`, `selling_price`, `min_stock_level`, `is_active`).

#### 6. Financial & Standard Units Master Data Domain
- **`currencies`**: Currency codes and symbols (`code` e.g. "INR", "USD", `symbol`, `name`, `is_active`).
- **`units_of_measurement` (UOM)**: Measurement units (`code` e.g. "KG", "PCS", `name`, `symbol`).
- **`hsn_codes`**: Tax classification tariff codes (`code`, `description`, `gst_rate`).

#### 7. Supplier Management Domain
- **`suppliers`**: Supplier/Vendor master directory (`code`, `name`, `legal_name`, `tax_id`, `pan_number`, `status`, `payment_terms_days`, `credit_limit`, `rating`, `address_line1`, `address_line2`, `city_id`, `state_id`, `country_id`, `postal_code`, `currency_id`).
- **`supplier_emails`**: Supplier notification email contacts (`supplier_id`, `email`, `email_type`, `is_primary`).
- **`supplier_contacts`**: Supplier contact personnel (`supplier_id`, `name`, `designation`, `email`, `phone`, `is_primary`).
- **`supplier_category_links`**: Junction table linking suppliers to product categories.
- **`supplier_sub_category_links`**: Junction table linking suppliers to product sub-categories.

#### 8. System Infrastructure & Audit Trail Domain
- **`audit_logs`**: System audit records (`actor_id`, `actor_email`, `action`, `resource_type`, `resource_id`, `request_id`, `ip_address`, `user_agent`, `changes_before`, `changes_after`).
- **`queue_jobs`**: DB-backed background task queue (`task_name`, `payload`, `status`, `max_retries`, `retry_count`, `error_message`, `scheduled_at`, `started_at`, `completed_at`).

---

### Supabase Integration & Setup Details

1. **Connection Pooling (PgBouncer)**:
   - Supabase project connection string uses port **6543** (PgBouncer transaction-mode pooler).
   - In `.env`:
     ```env
     DATABASE_URL=postgresql+asyncpg://postgres.[PROJECT_REF]:[PASSWORD]@[HOST]:6543/postgres
     DATABASE_DISABLE_STATEMENT_CACHE=true
     ```
   - Disabling statement cache (`DATABASE_DISABLE_STATEMENT_CACHE=true`) is required because PgBouncer multiplexes queries across server connections, preventing `prepared statement does not exist` errors.

2. **Schema & Tables Location**:
   - All 29 tables are created under Supabase's default **`public`** schema using Alembic migrations (`alembic upgrade head`).

3. **Supabase Useful Inspection Query**:
   You can run this query in the **Supabase SQL Editor** to see all tables and their row counts:
   ```sql
   SELECT 
       table_name, 
       (xpath('/row/cnt/text()', xml_count))[1]::text::int AS row_count
   FROM (
       SELECT table_name, table_schema,
              query_to_xml(format('SELECT COUNT(*) AS cnt FROM %I.%I', table_schema, table_name), false, true, '') AS xml_count
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ) sub
   ORDER BY table_name;
   ```

---

## 5. Frontend Deep Dive

The frontend is designed for maximum speed, maintainability, and zero build tool overhead:
- **No NPM / Webpack / Vite build step**: Pure HTML5, CSS3, and ES6 JavaScript modules.
- **`js/api.js`**: Core HTTP client module handling standard request headers, authorization bearer tokens, token refresh on 401 response, and API error notifications.
- **`js/auth.js`**: Manages user login state, token persistence in `localStorage`, and logout cleanup.
- **Single Page View Controllers**: Each HTML page operates independently with embedded JS handling interactive datatables, filtering, pagination, and modals.

---

## 6. Git & GitHub Operations Notice

> [!IMPORTANT]
> **Safety Rule Enforced**: No code, documentation, or files will be pushed to GitHub (`https://github.com/rupeshinhyma-oss/ERP_Main_Claude`) automatically. All changes made remain local to your development workspace. When you are ready to push changes in the future, you can issue an explicit directive specifying what to commit and push.
