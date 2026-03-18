import React from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #1e3a5f 0%, #0f2340 100%)',
    }}>
      <div style={{
        background: 'white', borderRadius: 12, padding: '48px 40px', maxWidth: 400, width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)', textAlign: 'center',
      }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📊</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>
          PDI FinOps Intelligence
        </h1>
        <p style={{ color: '#64748b', marginBottom: 32, fontSize: 14 }}>
          Infrastructure cost analysis &amp; right-sizing recommendations
        </p>
        <button
          onClick={login}
          style={{
            width: '100%', padding: '12px 24px', background: '#0066cc', color: 'white',
            border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Sign in with Okta
        </button>
        <p style={{ marginTop: 16, fontSize: 12, color: '#94a3b8' }}>
          PDI employees only · Okta SSO required
        </p>
      </div>
    </div>
  );
}
