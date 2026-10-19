import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { ToastProvider, Spinner } from './ui';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditPage } from './pages/AuditPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { ProductsPage } from './pages/ProductsPage';
import { BarcodePage } from './pages/BarcodePage';
import { PosPage } from './pages/PosPage';
import { CustomersPage } from './pages/CustomersPage';
import { InventoryPage } from './pages/InventoryPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { SuppliersPage } from './pages/SuppliersPage';
import { ReturnsPage } from './pages/ReturnsPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { ReportsPage } from './pages/ReportsPage';
import { UsersPage } from './pages/UsersPage';

function RequireAuth({ children, ownerOnly }: { children: React.ReactNode; ownerOnly?: boolean }) {
  const { user, loading } = useAuth();
  const loc = useLocation();

  if (loading)
    return (
      <div className="login-wrap">
        <Spinner />
      </div>
    );
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (ownerOnly && user.role !== 'owner') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />

          {/* Phase 4 */}
          <Route path="pos" element={<PosPage />} />

          {/* Phase 2 */}
          <Route path="products" element={<ProductsPage />} />
          <Route path="categories" element={<CategoriesPage />} />

          {/* Phase 3 */}
          <Route
            path="barcode"
            element={
              <RequireAuth ownerOnly>
                <BarcodePage />
              </RequireAuth>
            }
          />

          {/* Phase 5 */}
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="purchases" element={<PurchasesPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />

          {/* Phase 6 */}
          <Route path="customers" element={<CustomersPage />} />

          {/* Phase 7 */}
          <Route path="expenses" element={<ExpensesPage />} />

          {/* Phase 8 */}
          <Route path="returns" element={<ReturnsPage />} />

          {/* Phase 9 */}
          <Route path="reports" element={<ReportsPage />} />

          {/* Phase 1 */}
          <Route
            path="audit"
            element={
              <RequireAuth ownerOnly>
                <AuditPage />
              </RequireAuth>
            }
          />
          <Route
            path="settings"
            element={
              <RequireAuth ownerOnly>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="users"
            element={
              <RequireAuth ownerOnly>
                <UsersPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
