import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/AppShell";
import { MarketingLayout } from "./components/layout/MarketingLayout";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
import { Toaster } from "./components/ui/Toaster";
import { UploadProvider } from "./hooks/useUploads";
import Landing from "./pages/Landing";
import NotFound from "./pages/NotFound";

// Signed-in screens are split out so the landing page stays light.
const Library = lazy(() => import("./pages/app/Library"));
const Search = lazy(() => import("./pages/app/Search"));
const Bills = lazy(() => import("./pages/app/Bills"));
const Settings = lazy(() => import("./pages/app/Settings"));
const People = lazy(() => import("./pages/app/People"));

export default function App() {
  return (
    <>
      <Suspense fallback={null}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route index element={<Landing />} />
            {/* Old standalone pages now live as sections on the landing page. */}
            <Route path="about" element={<Navigate to="/#features" replace />} />
            <Route path="security" element={<Navigate to="/#security" replace />} />
            <Route path="our-team" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="auth/callback" element={<Navigate to="/app" replace />} />
          <Route element={<ProtectedRoute />}>
            <Route
              path="app"
              element={
                <UploadProvider>
                  <AppShell />
                </UploadProvider>
              }
            >
              <Route index element={<Library />} />
              <Route path="search" element={<Search />} />
              <Route path="people" element={<People />} />
              <Route path="bills" element={<Bills />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Route>
          {/* Legacy URLs */}
          <Route path="dashboard" element={<Navigate to="/app" replace />} />
          <Route path="bill-hub" element={<Navigate to="/app/bills" replace />} />
          <Route path="profile" element={<Navigate to="/app/settings" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
