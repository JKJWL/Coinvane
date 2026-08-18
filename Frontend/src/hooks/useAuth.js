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

  // Exchange a Microsoft (MSAL) ID token for our JWT. Same shape as
  // googleSignIn — server-side allowlist + user upsert converges on
  // the same users row as Google + One-Time-Link via email dedup.
  const microsoftSignIn = async (idToken) => {
    const res = await api.microsoftLogin(idToken);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  };

  // Redeem a one-time email sign-in token. Returns the full server
  // response — { token, user, handoffCode, handoffExpiresMinutes } —
  // WITHOUT committing the session. The caller decides when to call
  // commitSession() so it can first show the handoff code to the user
  // (needed for iOS Safari -> installed PWA cross-context sign-in).
  const verifyOneTimeLinkOnly = async (linkToken) => {
    return await api.verifyOneTimeLink(linkToken);
  };

  // Redeem a handoff code from within the installed PWA. Server hands
  // back a full session so this commits immediately.
  const handoffCodeSignIn = async (code) => {
    const res = await api.oneTimeLinkHandoff(code);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  };

  // Commit a { token, user } pair (e.g. from verifyOneTimeLinkOnly).
  const commitSession = ({ token, user: u }) => {
    setToken(token);
    setUser(u);
  };

  const logout = () => { setToken(null); setUser(null); };

  return {
    user, loading, googleSignIn, microsoftSignIn,
    verifyOneTimeLinkOnly, handoffCodeSignIn, commitSession,
    logout, refresh, setUser,
  };
}
