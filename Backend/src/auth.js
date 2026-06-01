// SPDX-License-Identifier: AGPL-3.0-or-later
import bcrypt from "bcrypt";
import { queryOne } from "./db.js";

export async function verifyCredentials(email, password) {
  const user = await queryOne(
    "SELECT id, email, name, role, password_hash, currency, timezone FROM users WHERE email = ?",
    [email]
  );
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return user;
}