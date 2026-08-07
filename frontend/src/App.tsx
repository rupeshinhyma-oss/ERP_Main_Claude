/**
 * Routes.
 *
 * Each `*.html` page in the original app becomes one route. The old filenames
 * are kept as redirects so existing bookmarks and any links still pointing at
 * `/masters-countries.html` continue to resolve -- including
 * `employee-detail.html` and `employee-form.html`, which were already just
 * redirect stubs pointing at User Management.
 */

import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { setUnauthorizedHandler } from "@/lib/api";
import { LEGACY_REDIRECTS } from "@/lib/nav";

import { LoginPage } from "@/pages/Login";
import { DashboardPage } from "@/pages/Dashboard";
import { ForbiddenPage } from "@/pages/Forbidden";
import { OrganizationPage } from "@/pages/Organization";
import { AuditPage } from "@/pages/Audit";
import { UsersPage } from "@/pages/Users";
import { ProfilePage } from "@/pages/Profile";
import { RbacPage } from "@/pages/Rbac";
import { EffectivePermissionsPage } from "@/pages/EffectivePermissions";
import { TeamsPage } from "@/pages/Teams";
import { SuppliersPage } from "@/pages/Suppliers";
import { TasksPage } from "@/pages/Tasks";
import { BuyersPage } from "@/pages/Buyers";
import { InquiriesPage } from "@/pages/Inquiries";

import { CountriesPage } from "@/pages/masters/Countries";
import { StatesPage } from "@/pages/masters/States";
import { CitiesPage } from "@/pages/masters/Cities";
import { CurrenciesPage } from "@/pages/masters/Currencies";
import { UomPage } from "@/pages/masters/Uom";
import { HsnPage } from "@/pages/masters/Hsn";
import { BrandsPage } from "@/pages/masters/Brands";
import { CategoriesPage } from "@/pages/masters/Categories";
import { SubCategoriesPage } from "@/pages/masters/SubCategories";
import { ProductsPage } from "@/pages/masters/Products";
import { NetworkStatusNotifier } from "@/components/NetworkStatusNotifier";

export function App() {
  const navigate = useNavigate();

  // Let the API client bounce expired sessions through the router rather than
  // a full page load.
  useEffect(() => {
    setUnauthorizedHandler(() => navigate("/login", { replace: true }));
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  return (
    <>
      <NetworkStatusNotifier />
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/403" element={<ForbiddenPage />} />
      <Route path="/organization" element={<OrganizationPage />} />
      <Route path="/audit" element={<AuditPage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/users" element={<UsersPage />} />
      <Route path="/rbac" element={<RbacPage />} />
      <Route path="/effective-permissions" element={<EffectivePermissionsPage />} />
      <Route path="/teams" element={<TeamsPage />} />
      <Route path="/suppliers" element={<SuppliersPage />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/buyers" element={<BuyersPage />} />
      <Route path="/inquiries" element={<InquiriesPage />} />

      <Route path="/masters/countries" element={<CountriesPage />} />
      <Route path="/masters/states" element={<StatesPage />} />
      <Route path="/masters/cities" element={<CitiesPage />} />
      <Route path="/masters/currencies" element={<CurrenciesPage />} />
      <Route path="/masters/uom" element={<UomPage />} />
      <Route path="/masters/hsn" element={<HsnPage />} />
      <Route path="/masters/brands" element={<BrandsPage />} />
      <Route path="/masters/categories" element={<CategoriesPage />} />
      <Route path="/masters/subcategories" element={<SubCategoriesPage />} />
      <Route path="/masters/products" element={<ProductsPage />} />

      {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
        <Route key={from} path={from} element={<Navigate to={to} replace />} />
      ))}

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </>
  );
}
