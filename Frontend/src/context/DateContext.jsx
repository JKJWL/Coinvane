import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api } from "../api/client.js";

const DataContext = createContext(null);

export function DataProvider({ children, enabled }) {
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [goals, setGoals] = useState([]);
  const [notes, setNotes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [summary, setSummary] = useState(null);
  const [investSummary, setInvestSummary] = useState(null);
  const [cashflow, setCashflow] = useState([]);
  const [byCategory, setByCategory] = useState([]);
  const [loading, setLoading] = useState(false);

  const refreshAll = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [acc, txn, bud, gol, not, cat, ntf, hld, sum, isum, cf, bc] = await Promise.all([
        api.getAccounts(), api.getTransactions({ limit: 200 }), api.getBudgets(),
        api.getGoals(), api.getNotes(), api.getCategories(), api.getNotifications(),
        api.getHoldings(), api.getAccountSummary(), api.getInvestmentSummary(),
        api.getCashflow(), api.getByCategory(),
      ]);
      setAccounts(acc); setTransactions(txn); setBudgets(bud); setGoals(gol);
      setNotes(not); setCategories(cat); setNotifications(ntf); setHoldings(hld);
      setSummary(sum); setInvestSummary(isum); setCashflow(cf); setByCategory(bc);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { if (enabled) refreshAll(); }, [enabled, refreshAll]);

  const value = {
    accounts, transactions, budgets, goals, notes, categories, notifications,
    holdings, summary, investSummary, cashflow, byCategory, loading,
    refreshAll,
    setAccounts, setTransactions, setBudgets, setGoals, setNotes,
    setCategories, setNotifications, setHoldings,
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used within DataProvider");
  return ctx;
}