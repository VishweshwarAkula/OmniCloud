import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/AppShell";
import { Toaster } from "./components/ui/Toaster";
import { UploadProvider } from "./hooks/useUploads";
import NotFound from "./pages/NotFound";

// Pages are split out so the first load stays light.
const Library = lazy(() => import("./pages/app/Library"));
const Search = lazy(() => import("./pages/app/Search"));
const Settings = lazy(() => import("./pages/app/Settings"));
const People = lazy(() => import("./pages/app/People"));

export default function App() {
  return (
    <>
      <Suspense fallback={null}>
        <Routes>
          {/* Single-user local app: no landing page or sign-in, straight into the library. */}
          <Route index element={<Navigate to="/app" replace />} />
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
            <Route path="settings" element={<Settings />} />
          </Route>
          {/* Legacy URLs */}
          <Route path="dashboard" element={<Navigate to="/app" replace />} />
          <Route path="bill-hub" element={<Navigate to="/app" replace />} />
          <Route path="app/bills" element={<Navigate to="/app" replace />} />
          <Route path="profile" element={<Navigate to="/app/settings" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
