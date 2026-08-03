# ERP Admin Frontend

Plain HTML/CSS/JS admin UI (no build step, no framework) for the Phase 6
backend — Dashboard, Organization Settings, Departments, Designations,
Employees.

## Pages

- `login.html` — sign in, stores the access/refresh tokens + profile
- `index.html` — dashboard (counts, quick links)
- `organization.html` — create/edit the singleton company profile
- `departments.html` — list, search, filter, create/edit, delete
- `designations.html` — list, search, filter, create/edit, delete
- `employees.html` — searchable/filterable/sortable paginated list
- `employee-detail.html` — profile + transfer department, change
  designation, assign manager, link user, deactivate/reactivate, delete
- `employee-form.html` — shared create/edit form

## Pointing it at the API

`js/api.js` calls the backend at a relative path:

```js
const API_BASE = "/api/v1";
```

This assumes the frontend is served from the **same origin** as the API
(e.g. behind one reverse proxy, or the backend mounts this folder itself).
If you're serving the frontend separately (its own static host, a CDN,
`python -m http.server`, etc.), either:

1. **Reverse-proxy** `/api/v1` on the frontend's origin through to the
   backend (nginx, Caddy, etc.) — no code changes needed, or
2. **Point at an absolute URL** — change the one line above to your
   backend's origin, e.g. `const API_BASE = "https://api.example.com/api/v1";`
   and make sure the backend's CORS settings (`CORS_ALLOWED_ORIGINS` etc.
   in the backend's `.env`) allow the frontend's origin.

## Running locally

No build step — just serve the directory statically, e.g.:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/login.html
```

(and make sure the backend is reachable at `/api/v1` from that origin, per
above).
