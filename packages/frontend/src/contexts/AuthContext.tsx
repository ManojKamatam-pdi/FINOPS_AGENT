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
  const [token, setToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    if (authState?.isAuthenticated) {
      const accessToken = oktaAuth.getAccessToken();
      setToken(accessToken || null);
      oktaAuth.getUser().then((user) => {
        setUserEmail(user.email || user.sub || null);
      }).catch(() => {});
    } else {
      setToken(null);
      setUserEmail(null);
    }
  }, [authState, oktaAuth]);

  const login = () => oktaAuth.signInWithRedirect();
  const logout = () => {
    oktaAuth.tokenManager.clear();
    window.location.href = '/login';
  };

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
