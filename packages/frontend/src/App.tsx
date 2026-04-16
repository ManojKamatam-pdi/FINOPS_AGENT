import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Security, LoginCallback } from '@okta/okta-react';
import { OktaAuth, toRelativeUrl } from '@okta/okta-auth-js';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import RunProgressPage from './pages/RunProgressPage';
import SloAuditPage from './pages/SloAuditPage';
import SloRunProgressPage from './pages/SloRunProgressPage';

const oktaAuth = new OktaAuth({
  issuer: process.env.REACT_APP_OKTA_ISSUER || '',
  clientId: process.env.REACT_APP_OKTA_CLIENT_ID || '',
  redirectUri: `${window.location.origin}/login/callback`,
  scopes: ['openid', 'profile', 'email'],
  pkce: true,
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <div style={{ padding: 32, color: '#64748b' }}>Loading...</div>;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/callback" element={<LoginCallback />} />
      <Route path="/" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
      <Route path="/run/:runId" element={<ProtectedRoute><RunProgressPage /></ProtectedRoute>} />
      <Route path="/slo" element={<ProtectedRoute><SloAuditPage /></ProtectedRoute>} />
      <Route path="/slo/run/:runId" element={<ProtectedRoute><SloRunProgressPage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const restoreOriginalUri = async (_oktaAuth: OktaAuth, originalUri: string) => {
    window.location.replace(toRelativeUrl(originalUri || '/', window.location.origin));
  };

  return (
    <BrowserRouter>
      <Security oktaAuth={oktaAuth} restoreOriginalUri={restoreOriginalUri}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </Security>
    </BrowserRouter>
  );
}
