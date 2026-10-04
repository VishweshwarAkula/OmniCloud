import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { Logo } from "../ui/Brand";

export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <Logo className="animate-pulse text-lg text-mist" />
      </div>
    );
  }
  if (!user) return <Navigate to="/" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}
