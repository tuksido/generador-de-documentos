import React, { createContext, useContext, useState, useEffect } from 'react';

interface User {
  id: number;
  email: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  forgotPassword: (email: string) => Promise<{ debug_token?: string }>;
  resetPassword: (token: string, newPassword: string) => Promise<void>;
}

const AUTH_STORAGE_KEY = 'docugen_user';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Restore user from localStorage immediately to avoid flash of login screen
  const [user, setUser] = useState<User | null>(() => {
    try {
      const stored = localStorage.getItem(AUTH_STORAGE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  // If we have a cached user, don't show loading spinner — validate in background
  const [loading, setLoading] = useState(() => {
    try {
      return !localStorage.getItem(AUTH_STORAGE_KEY);
    } catch {
      return true;
    }
  });

  const persistUser = (u: User | null) => {
    setUser(u);
    if (u) {
      try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(u)); } catch {}
    } else {
      try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
    }
  };

  useEffect(() => {
    // Always validate the session with the server in the background
    fetch('/api/auth/me', { credentials: 'include' })
      .then(res => {
        if (res.status === 401 || res.status === 403) {
          // Server explicitly says session is invalid — clear it
          persistUser(null);
          setLoading(false);
          return null;
        }
        if (!res.ok) {
          // Server error (500, etc.) or Render waking up — keep cached user
          setLoading(false);
          return null;
        }
        return res.json();
      })
      .then(data => {
        if (data !== null && data !== undefined) {
          persistUser(data.user);
        }
        setLoading(false);
      })
      .catch(() => {
        // Network error (e.g. server waking up) — keep cached user, don't log out
        setLoading(false);
      });
  }, []);

  const login = async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    persistUser(data.user);
  };

  const signup = async (email: string, password: string) => {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');
    persistUser(data.user);
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {
      console.error('Logout fetch failed', e);
    }
    persistUser(null);
  };

  const forgotPassword = async (email: string) => {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send reset link');
    return data;
  };

  const resetPassword = async (token: string, newPassword: string) => {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to reset password');
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, forgotPassword, resetPassword }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
