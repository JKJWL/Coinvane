// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback } from "react";
import { api, setToken, getToken } from "../api/client.js";

export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) { setUser(null); setLoading(false); return; }
    try {
      const me = await api.me();
      setUser(me);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Exchange a Google ID token for our JWT
  const googleSignIn = async (idToken) => {
    const res = await api.googleLogin(idToken);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  };

  const logout = () => { setToken(null); setUser(null); };

  return { user, loading, googleSignIn, logout, refresh, setUser };
}
