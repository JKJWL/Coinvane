// SPDX-License-Identifier: AGPL-3.0-or-later
import { query, queryOne } from "../db.js";

const ALLOWED_KINDS = new Set([
  "vehicle", "boat", "jewelry", "art", "collectible", "property", "other",
]);
const ALLOWED_METHODS = new Set(["none", "straight_line", "declining_balance"]);

// Compute the "should-be" value today per the depreciation curve.
// Called from GET / to surface the projected value even if the user
// hasn't clicked "refresh depreciation" yet. Persisted current_value
// isn't overwritten — the compute is display-only.
export function projectDepreciatedValue(asset, atDate = new Date()) {
  const acquired = Number(asset.acquired_value);
  const salvage  = Number(asset.salvage_value || 0);
  if (!(acquired > 0)) return 0;
  const life = Number(asset.useful_life_years || 0);
  const method = asset.depreciation_method;
  const start = new Date(asset.acquired_date);
  const yearsElapsed = Math.max(0, (atDate - start) / (365.25 * 24 * 3600 * 1000));

  if (method === "straight_line" && life > 0) {
    if (yearsElapsed >= life) return salvage;
    const drop = (acquired - salvage) * (yearsElapsed / life);
    return Math.max(salvage, acquired - drop);
  }
  if (method === "declining_balance") {
    const rate = Number(asset.declining_rate || 20) / 100;
    if (!(rate > 0 && rate < 1)) return acquired;
    const val = acquired * Math.pow(1 - rate, yearsElapsed);
    return Math.max(salvage, val);
  }
  return acquired;
}

export default async function (app) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const rows = await query(
      `SELECT id, name, kind, acquired_date AS acquiredDate,
              acquired_value AS acquiredValue,
              current_value AS currentValue,
              salvage_value AS salvageValue,
              useful_life_years AS usefulLifeYears,
              depreciation_method AS depreciationMethod,
              declining_rate AS decliningRate,
              notes, created_at AS createdAt
       FROM assets
       WHERE user_id = ? AND archived_at IS NULL
       ORDER BY current_value DESC`,
      [req.user.id]
    );
    // Aggregate damage/repair impact per asset (positive = value lost).
    const damageRows = await query(
      `SELECT asset_id, COALESCE(SUM(value_impact), 0) AS total,
              COUNT(*) AS event_count
       FROM asset_damage_events
       WHERE user_id = ?
       GROUP BY asset_id`,
      [req.user.id]
    );
    const damageByAsset = new Map(damageRows.map(d => [d.asset_id, d]));
    for (const r of rows) {
      const d = damageByAsset.get(r.id);
      r.damageTotal = Number(d?.total || 0);
      r.damageEventCount = Number(d?.event_count || 0);
      // Projected value from the depreciation curve, then damage applied on top.
      const baseProjection = projectDepreciatedValue({
        acquired_value: r.acquiredValue,
        salvage_value: r.salvageValue,
        useful_life_years: r.usefulLifeYears,
        depreciation_method: r.depreciationMethod,
        declining_rate: r.decliningRate,
        acquired_date: r.acquiredDate,
      });
      r.projectedValue = Number(Math.max(0, baseProjection - r.damageTotal).toFixed(2));
    }
    return rows;
  });

  // ── Damage / impairment events ─────────────────────────────────────
  app.get("/:id/damage", async (req, reply) => {
    const owned = await queryOne("SELECT id FROM assets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    if (!owned) return reply.code(404).send({ error: "not found" });
    return query(
      `SELECT id, event_date AS eventDate, description,
              value_impact AS valueImpact, created_at AS createdAt
       FROM asset_damage_events
       WHERE asset_id = ? AND user_id = ?
       ORDER BY event_date DESC, id DESC`,
      [req.params.id, req.user.id]
    );
  });

  app.post("/:id/damage", async (req, reply) => {
    const asset = await queryOne(
      "SELECT id, current_value FROM assets WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!asset) return reply.code(404).send({ error: "not found" });
    const b = req.body || {};
    const impact = Number(b.value_impact);
    if (!b.description || !b.event_date || !Number.isFinite(impact) || impact === 0) {
      return reply.code(400).send({ error: "description, event_date, non-zero value_impact required" });
    }
    const desc = String(b.description).slice(0, 255);
    await query(
      `INSERT INTO asset_damage_events (user_id, asset_id, event_date, description, value_impact)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, asset.id, b.event_date, desc, impact]
    );
    // Damage subtracts, repairs add back. Clamp at zero.
    const newVal = Math.max(0, Number(asset.current_value) - impact);
    await query("UPDATE assets SET current_value = ? WHERE id = ?", [newVal, asset.id]);
    return { ok: true, current_value: newVal };
  });

  app.delete("/damage/:eventId", async (req, reply) => {
    const evt = await queryOne(
      `SELECT e.id, e.asset_id, e.value_impact, a.current_value
       FROM asset_damage_events e
       JOIN assets a ON a.id = e.asset_id
       WHERE e.id = ? AND e.user_id = ?`,
      [req.params.eventId, req.user.id]
    );
    if (!evt) return reply.code(404).send({ error: "not found" });
    await query("DELETE FROM asset_damage_events WHERE id = ? AND user_id = ?",
      [evt.id, req.user.id]);
    // Reverse the impact — add it back to current_value.
    const restored = Number(evt.current_value) + Number(evt.value_impact);
    await query("UPDATE assets SET current_value = ? WHERE id = ?", [restored, evt.asset_id]);
    return { ok: true, current_value: restored };
  });

  app.get("/summary", async (req) => {
    const rows = await query(
      "SELECT COALESCE(SUM(current_value), 0) AS total FROM assets WHERE user_id = ? AND archived_at IS NULL",
      [req.user.id]
    );
    return { total: Number(rows[0]?.total || 0) };
  });

  app.post("/", async (req, reply) => {
    const b = req.body || {};
    if (!b.name || !b.acquired_date || !(Number(b.acquired_value) >= 0)) {
      return reply.code(400).send({ error: "name, acquired_date, acquired_value required" });
    }
    const kind = ALLOWED_KINDS.has(b.kind) ? b.kind : "other";
    const method = ALLOWED_METHODS.has(b.depreciation_method) ? b.depreciation_method : "none";
    const acquired = Number(b.acquired_value);
    const current = Number(b.current_value ?? acquired);
    const r = await query(
      `INSERT INTO assets
         (user_id, name, kind, acquired_date, acquired_value, current_value,
          salvage_value, useful_life_years, depreciation_method, declining_rate, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        String(b.name).slice(0, 128),
        kind, b.acquired_date, acquired, current,
        Math.max(0, Number(b.salvage_value) || 0),
        Math.max(0, Number(b.useful_life_years) || 0),
        method,
        Math.max(0, Math.min(99, Number(b.declining_rate) || 20)),
        b.notes ? String(b.notes).slice(0, 500) : null,
      ]
    );
    return queryOne("SELECT * FROM assets WHERE id = ?", [r.insertId]);
  });

  app.patch("/:id", async (req, reply) => {
    const owned = await queryOne("SELECT id FROM assets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]);
    if (!owned) return reply.code(404).send({ error: "not found" });
    const b = req.body || {};
    const kind   = b.kind && ALLOWED_KINDS.has(b.kind) ? b.kind : null;
    const method = b.depreciation_method && ALLOWED_METHODS.has(b.depreciation_method) ? b.depreciation_method : null;
    await query(
      `UPDATE assets SET
         name = COALESCE(?, name),
         kind = COALESCE(?, kind),
         acquired_date = COALESCE(?, acquired_date),
         acquired_value = COALESCE(?, acquired_value),
         current_value = COALESCE(?, current_value),
         salvage_value = COALESCE(?, salvage_value),
         useful_life_years = COALESCE(?, useful_life_years),
         depreciation_method = COALESCE(?, depreciation_method),
         declining_rate = COALESCE(?, declining_rate),
         notes = COALESCE(?, notes)
       WHERE id = ? AND user_id = ?`,
      [
        b.name ?? null, kind,
        b.acquired_date ?? null,
        b.acquired_value !== undefined ? Number(b.acquired_value) : null,
        b.current_value !== undefined ? Number(b.current_value) : null,
        b.salvage_value !== undefined ? Number(b.salvage_value) : null,
        b.useful_life_years !== undefined ? Number(b.useful_life_years) : null,
        method,
        b.declining_rate !== undefined ? Number(b.declining_rate) : null,
        b.notes ?? null,
        req.params.id, req.user.id,
      ]
    );
    return queryOne("SELECT * FROM assets WHERE id = ?", [req.params.id]);
  });

  // Snap current_value to the projected depreciation for today, minus
  // any logged damage. Depreciation is time-based; damage events are
  // point-in-time deductions that must survive the refresh.
  app.post("/:id/refresh", async (req, reply) => {
    const asset = await queryOne(
      "SELECT * FROM assets WHERE id = ? AND user_id = ?",
      [req.params.id, req.user.id]
    );
    if (!asset) return reply.code(404).send({ error: "not found" });
    const damage = await queryOne(
      "SELECT COALESCE(SUM(value_impact), 0) AS total FROM asset_damage_events WHERE asset_id = ? AND user_id = ?",
      [asset.id, req.user.id]
    );
    const projected = Number(projectDepreciatedValue(asset).toFixed(2));
    const withDamage = Number(Math.max(0, projected - Number(damage?.total || 0)).toFixed(2));
    await query("UPDATE assets SET current_value = ? WHERE id = ?", [withDamage, asset.id]);
    return { ok: true, current_value: withDamage };
  });

  app.delete("/:id", async (req, reply) => {
    const r = await query(
      "UPDATE assets SET archived_at = NOW() WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      [req.params.id, req.user.id]
    );
    if (!r.affectedRows) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
}
