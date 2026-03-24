import React, { createContext, useContext, useEffect, useState } from 'react';
import { useOktaAuth } from '@okta/okta-react';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  userEmail: string | null;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  isAuthenticated: false,
  isLoading: true,
  token: null,
  userEmail: null,
  login: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { oktaAuth, authState } = useOktaAuth();
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    if (authState?.isAuthenticated) {
      oktaAuth.getUser().then((user) => {
        setUserEmail(user.email || user.sub || null);
      }).catch(() => {});
    } else {
      setUserEmail(null);
    }
  }, [authState, oktaAuth]);

  const login = () => oktaAuth.signInWithRedirect();
  const logout = () => {
    oktaAuth.tokenManager.clear();
    window.location.href = '/login';
  };

  // Read fresh from tokenManager on every render — Okta silently renews the token
  // in the background without triggering an authState change, so caching it in state
  // would return a stale expired token after ~1 hour.
  const token = authState?.isAuthenticated ? (oktaAuth.getAccessToken() ?? null) : null;

  return (
    <AuthContext.Provider value={{
      isAuthenticated: authState?.isAuthenticated ?? false,
      isLoading: !authState,
      token,
      userEmail,
      login,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
