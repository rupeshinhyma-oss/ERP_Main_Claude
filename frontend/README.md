# ERP Admin Frontend — React + TypeScript + Vite

A complete rewrite of the plain HTML/CSS/JS admin frontend as a single-page
React application. Same backend, same API contract, same UI — every page,
label, placeholder, table column and modal reproduced from the original.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:8000`, so the browser sees
one origin and CORS is a non-issue. Point it elsewhere with:

```bash
VITE_API_PROXY_TARGET=http://192.168.1.20:8000 npm run dev
```

Other scripts:

```bash
npm run build        # typecheck + production build into dist/
npm run typecheck    # tsc --noEmit
npm run preview      # serve the built dist/
```

### Deploying

`npm run build` emits a static `dist/`. Two supported setups:

1. **Same origin (recommended).** Serve `dist/` from the backend or behind one
   reverse proxy that also routes `/api/v1`. Leave `VITE_API_ORIGIN` unset.
2. **Separate origin.** Set `VITE_API_ORIGIN=https://api.example.com` at build
   time and add this app's origin to the backend's `CORS_ALLOWED_ORIGINS`.

Because this is a client-side-routed SPA, the static host must rewrite unknown
paths to `index.html` (nginx: `try_files $uri $uri/ /index.html;`). Without
that, deep links like `/masters/products` 404 on refresh.

## Layout

```
src/
  main.tsx               entry: Router + ToastProvider
  App.tsx                routes, plus redirects from the old *.html paths
  styles/
    style.css            the original stylesheet, copied byte-for-byte
    pages.css            the per-page <style> blocks, scoped (see below)
  lib/
    api.ts               fetch client, response envelope, single-flight refresh
    auth.ts              session store + permission alias resolution
    hooks.ts             useAuth, debounce, cancellable search, scroll lock
    nav.ts               sidebar sections, page titles, routes
    brand.ts             company-name cache
    lookups.ts           master-table lookup loader
    nameResolver.ts      bounded id -> name cache for list columns
    toast.tsx            toast notifications
  components/
    AppShell.tsx         sidebar + topbar + access guard + notifications
    MasterPage.tsx       the engine behind all ten Master Data pages
    ImportWizard.tsx     CSV/XLSX column-mapping import
    SearchableDropdown.tsx  type-ahead single/multi select
    Pagination.tsx       page-size selector + windowed page numbers
    fields.tsx, ui.tsx, icons.tsx, Breadcrumb.tsx
  pages/                 21 page components (10 of them under masters/)
  types/                 API and domain types
```

## How the original maps across

| Original | Now |
| --- | --- |
| `css/style.css` | `src/styles/style.css`, unchanged |
| per-page `<style>` blocks | `src/styles/pages.css`, scoped per page |
| `js/api.js` | `lib/api.ts` + `lib/auth.ts` + `lib/toast.tsx` |
| `js/nav.js` | `components/AppShell.tsx` + `lib/nav.ts` + `lib/brand.ts` |
| `js/masters-common.js` | `components/MasterPage.tsx` |
| `js/import-wizard.js` | `components/ImportWizard.tsx` |
| `js/dropdown-search.js` | `components/SearchableDropdown.tsx` + `lib/nameResolver.ts` |
| `js/teams.js` | `pages/Teams.tsx` |
| `js/suppliers.js` | `pages/Suppliers.tsx` |
| `js/tasks.js` | `pages/Tasks.tsx` |
| 23 `*.html` files | 21 page components + 2 router redirects |

Old URLs still work: `/masters-products.html` redirects to `/masters/products`,
and the two `employee-*.html` stubs redirect to `/users` as they always did.

## Behaviour carried over deliberately

These were load-bearing details in the original, and each is preserved:

- **Single-flight token refresh.** Refresh tokens are single-use and rotated
  server-side. When several parallel requests 401 at once, only one calls
  `/auth/refresh`; the rest await that same promise. Without this, concurrent
  requests race, all but one get a revoked token, and the user appears to be
  "randomly logged out".
- **Permission aliases.** `view`↔`read`, `export`→`read`/`view`,
  `import`→`create`, `employee.`↔`user.`, and hierarchical short forms
  (`masters.brand.create` → `brand.create`). Super admins bypass all checks.
- **Sidebar scroll memory.** Restored from `sessionStorage` and centred on the
  active item *instantly* — never smooth-scrolled, or the sidebar visibly
  slides on its own after each navigation.
- **Sr. No. jump.** A bare integer in a list page's search box means "take me
  to row N": it computes the page, loads it, scrolls to the row and flashes the
  highlight, rather than sending the number as a text search.
- **Chunked import.** Rows upload 250 at a time with live progress. Cancel
  aborts the in-flight chunk; chunks already committed stay committed. Row
  numbers in the merged error/duplicate report are offset back to their true
  position in the original file.
- **Bounded name resolution.** List columns resolve related names only for the
  IDs on the current page, so cost scales with page size rather than with the
  size of the Cities or Products tables.
- **Modal scroll lock.** Body scroll freezes while a modal is open and the
  position is restored on close, so a long form never opens with its Save
  button below the fold.

## Notable porting decisions

**Page-scoped CSS.** Several pages defined the *same* class names with
*different* rules — `.chip` meant three different things (Suppliers, RBAC,
Effective Permissions), and `.detail-label`, `.detail-grid`, `.modal-header`
and `.data-table` each had two competing definitions. That worked only because
a page never loaded another page's `<style>` block. A bundled SPA loads one
stylesheet for every route, so each page's former inline CSS now sits under a
page-root class (`.page-users`, `.page-tasks`, …). Declarations are otherwise
untouched. Without this, the Users page's `.detail-grid` override would have
silently broken Organization Settings, Teams and Audit.

**Permission gating is declarative.** The original tagged controls with
`data-permission` and removed them in a post-render sweep. They are now gated
at render time by a `<Can>` component reading the same permission logic, which
avoids the flash of a control that is about to be pulled and re-evaluates
automatically when permissions change.

**Dependent dropdowns derive from state.** State-scoped-to-Country,
Sub-Category-scoped-to-Category and the Products CBM preview no longer need
imperative `populate…Options()` calls from two places each; they compute from
current form state, so they cannot drift out of sync.

**Parser libraries are bundled, not CDN-loaded.** PapaParse and SheetJS are now
npm dependencies pulled in via dynamic `import()`. They still stay out of the
initial bundle — they load on first use, exactly as the lazy CDN script tags
did — but without the third-party runtime dependency.

## Two pre-existing issues left as-is

Both are faithful reproductions. Say the word and either is a small fix.

1. **Products table header is misaligned.** `masters-products.html` declared 13
   `<th>` cells but rendered 12 `<td>` cells per row — `Category / Sub-Cat.`
   has no matching data cell, so every header from it rightwards sits one
   column left of its data. Reproduced exactly; see the comment on
   `columnHeaders` in `pages/masters/Products.tsx`.
2. **Suppliers' select-all checkbox is inert.** The header checkbox and the
   per-row checkboxes were never wired to anything in `suppliers.js`. They
   render, but nothing reads them.

One thing was corrected, because it was a plain bug with no visual upside: the
static `colspan` on several "Loading…" rows disagreed with the real column
count (Countries said 7 for 8 columns, Products 11 for 12). The count is now
computed, so the loading and empty-state rows span the full table.
