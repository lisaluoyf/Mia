import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { ActivationCandidate, ActivationTemplateId, WeatherLocation, WeatherSubscription } from "./types.js";

interface CandidateRow { telegram_user_id: number; chat_id: number; language_code: string | null; first_seen_at: string; }
interface SubscriptionRow { telegram_user_id: number; chat_id: number; city_name: string; country: string; latitude: number; longitude: number; timezone: string; delivery_hour: number; status: "active" | "paused" | "cancelled"; next_delivery_at: string; }

function asCandidate(row: CandidateRow): ActivationCandidate {
  return { telegramUserId: row.telegram_user_id, chatId: row.chat_id, languageCode: row.language_code, firstSeenAt: row.first_seen_at };
}

function asSubscription(row: SubscriptionRow): WeatherSubscription {
  return {
    telegramUserId: row.telegram_user_id, chatId: row.chat_id,
    location: { name: row.city_name, country: row.country, latitude: row.latitude, longitude: row.longitude, timezone: row.timezone },
    deliveryHour: row.delivery_hour, status: row.status, nextDeliveryAt: row.next_delivery_at,
  };
}

export class ActivationStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mia_activation_deliveries (
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence IN (1, 2)),
        template_id TEXT NOT NULL CHECK (template_id IN ('introduction_v1', 'weather_invite_v1', 'companion_v1')),
        status TEXT NOT NULL CHECK (status IN ('claimed', 'sent', 'failed', 'interacted', 'dismissed')),
        planned_at TEXT NOT NULL,
        sent_at TEXT,
        interacted_at TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (telegram_user_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_mia_activation_second ON mia_activation_deliveries(sequence, status, sent_at);
      CREATE TABLE IF NOT EXISTS mia_activation_suppressions (
        telegram_user_id INTEGER PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS mia_weather_requests (
        telegram_user_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        city_name TEXT NOT NULL,
        country TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        timezone TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS mia_weather_intents (
        telegram_user_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS mia_weather_subscriptions (
        telegram_user_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        city_name TEXT NOT NULL,
        country TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        timezone TEXT NOT NULL,
        delivery_hour INTEGER NOT NULL CHECK (delivery_hour BETWEEN 0 AND 23),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled')),
        next_delivery_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mia_weather_due ON mia_weather_subscriptions(status, next_delivery_at);
    `);
  }

  close(): void { this.database.close(); }

  listFirstCandidates(limit: number): ActivationCandidate[] {
    const rows = this.database.prepare(`
      SELECT u.telegram_user_id, c.chat_id, u.language_code, MIN(m.sent_at) AS first_seen_at
      FROM mia_users u
      JOIN mia_chats c ON c.chat_id = u.telegram_user_id AND c.type = 'private'
      JOIN mia_messages m ON m.chat_id = c.chat_id AND m.sender_user_id = u.telegram_user_id
      LEFT JOIN mia_activation_deliveries d ON d.telegram_user_id = u.telegram_user_id AND d.sequence = 1
      LEFT JOIN mia_activation_suppressions s ON s.telegram_user_id = u.telegram_user_id
      WHERE d.telegram_user_id IS NULL AND s.telegram_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM mia_completed_turns t WHERE t.chat_id = c.chat_id AND t.user_id = u.telegram_user_id)
      GROUP BY u.telegram_user_id, c.chat_id, u.language_code
      ORDER BY first_seen_at ASC LIMIT ?
    `).all(limit) as CandidateRow[];
    return rows.map(asCandidate);
  }

  listSecondCandidates(now: Date, limit: number): ActivationCandidate[] {
    const rows = this.database.prepare(`
      SELECT d.telegram_user_id, d.chat_id, u.language_code, d.sent_at AS first_seen_at
      FROM mia_activation_deliveries d
      JOIN mia_users u ON u.telegram_user_id = d.telegram_user_id
      LEFT JOIN mia_activation_deliveries second ON second.telegram_user_id = d.telegram_user_id AND second.sequence = 2
      LEFT JOIN mia_activation_suppressions s ON s.telegram_user_id = d.telegram_user_id
      WHERE d.sequence = 1 AND d.status = 'sent' AND second.telegram_user_id IS NULL AND s.telegram_user_id IS NULL
        AND d.sent_at <= ? AND d.sent_at >= ?
      ORDER BY d.sent_at ASC LIMIT ?
    `).all(new Date(now.getTime() - 6 * 60 * 60 * 1_000).toISOString(), new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(), limit) as CandidateRow[];
    return rows.map(asCandidate);
  }

  firstTemplate(telegramUserId: number): ActivationTemplateId | null {
    const row = this.database.prepare("SELECT template_id FROM mia_activation_deliveries WHERE telegram_user_id = ? AND sequence = 1").get(telegramUserId) as { template_id: ActivationTemplateId } | undefined;
    return row?.template_id ?? null;
  }

  claimDelivery(candidate: ActivationCandidate, sequence: 1 | 2, templateId: ActivationTemplateId, now = new Date()): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO mia_activation_deliveries (telegram_user_id, chat_id, sequence, template_id, status, planned_at)
      VALUES (?, ?, ?, ?, 'claimed', ?)
    `).run(candidate.telegramUserId, candidate.chatId, sequence, templateId, now.toISOString());
    return result.changes === 1;
  }

  markSent(telegramUserId: number, sequence: 1 | 2, now = new Date()): void {
    this.database.prepare("UPDATE mia_activation_deliveries SET status = 'sent', sent_at = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ? AND sequence = ? AND status = 'claimed'")
      .run(now.toISOString(), telegramUserId, sequence);
  }

  markFailed(telegramUserId: number, sequence: 1 | 2, reason: string): void {
    this.database.prepare("UPDATE mia_activation_deliveries SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ? AND sequence = ?")
      .run(reason.slice(0, 500), telegramUserId, sequence);
  }

  markInteraction(telegramUserId: number, now = new Date()): void {
    this.database.prepare("UPDATE mia_activation_deliveries SET status = 'interacted', interacted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ? AND status = 'sent'")
      .run(now.toISOString(), telegramUserId);
  }

  dismiss(telegramUserId: number, permanent: boolean, now = new Date()): void {
    this.database.prepare("UPDATE mia_activation_deliveries SET status = 'dismissed', interacted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ? AND status = 'sent'")
      .run(now.toISOString(), telegramUserId);
    if (permanent) this.database.prepare("INSERT INTO mia_activation_suppressions (telegram_user_id, reason) VALUES (?, 'user_opt_out') ON CONFLICT(telegram_user_id) DO NOTHING").run(telegramUserId);
  }

  saveWeatherRequest(telegramUserId: number, chatId: number, location: WeatherLocation, now = new Date()): void {
    this.database.prepare(`
      INSERT INTO mia_weather_requests (telegram_user_id, chat_id, city_name, country, latitude, longitude, timezone, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id = excluded.chat_id, city_name = excluded.city_name, country = excluded.country,
        latitude = excluded.latitude, longitude = excluded.longitude, timezone = excluded.timezone, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP
    `).run(telegramUserId, chatId, location.name, location.country, location.latitude, location.longitude, location.timezone, new Date(now.getTime() + 30 * 60 * 1_000).toISOString());
  }

  beginWeatherIntent(telegramUserId: number, chatId: number, now = new Date()): void {
    this.database.prepare(`
      INSERT INTO mia_weather_intents (telegram_user_id, chat_id, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id = excluded.chat_id, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP
    `).run(telegramUserId, chatId, new Date(now.getTime() + 30 * 60 * 1_000).toISOString());
  }

  consumeWeatherIntent(telegramUserId: number, chatId: number, now = new Date()): boolean {
    const result = this.database.prepare("DELETE FROM mia_weather_intents WHERE telegram_user_id = ? AND chat_id = ? AND expires_at > ?")
      .run(telegramUserId, chatId, now.toISOString());
    return result.changes === 1;
  }

  getWeatherRequest(telegramUserId: number, now = new Date()): { chatId: number; location: WeatherLocation } | null {
    const row = this.database.prepare("SELECT * FROM mia_weather_requests WHERE telegram_user_id = ? AND expires_at > ?").get(telegramUserId, now.toISOString()) as (SubscriptionRow & { expires_at: string }) | undefined;
    return row ? { chatId: row.chat_id, location: { name: row.city_name, country: row.country, latitude: row.latitude, longitude: row.longitude, timezone: row.timezone } } : null;
  }

  createWeatherSubscription(telegramUserId: number, deliveryHour: number, nextDeliveryAt: Date): WeatherSubscription | null {
    const pending = this.getWeatherRequest(telegramUserId);
    if (!pending) return null;
    const { location } = pending;
    this.database.prepare(`
      INSERT INTO mia_weather_subscriptions (telegram_user_id, chat_id, city_name, country, latitude, longitude, timezone, delivery_hour, status, next_delivery_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id = excluded.chat_id, city_name = excluded.city_name, country = excluded.country,
        latitude = excluded.latitude, longitude = excluded.longitude, timezone = excluded.timezone, delivery_hour = excluded.delivery_hour,
        status = 'active', next_delivery_at = excluded.next_delivery_at, updated_at = CURRENT_TIMESTAMP
    `).run(telegramUserId, pending.chatId, location.name, location.country, location.latitude, location.longitude, location.timezone, deliveryHour, nextDeliveryAt.toISOString());
    const row = this.database.prepare("SELECT * FROM mia_weather_subscriptions WHERE telegram_user_id = ?").get(telegramUserId) as SubscriptionRow | undefined;
    return row ? asSubscription(row) : null;
  }

  getWeatherSubscription(telegramUserId: number): WeatherSubscription | null {
    const row = this.database.prepare("SELECT * FROM mia_weather_subscriptions WHERE telegram_user_id = ?").get(telegramUserId) as SubscriptionRow | undefined;
    return row ? asSubscription(row) : null;
  }

  setWeatherSubscriptionStatus(telegramUserId: number, status: "paused" | "cancelled"): void {
    this.database.prepare("UPDATE mia_weather_subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ?").run(status, telegramUserId);
  }

  listDueWeatherSubscriptions(now: Date, limit: number): WeatherSubscription[] {
    const rows = this.database.prepare("SELECT * FROM mia_weather_subscriptions WHERE status = 'active' AND next_delivery_at <= ? ORDER BY next_delivery_at ASC LIMIT ?")
      .all(now.toISOString(), limit) as SubscriptionRow[];
    return rows.map(asSubscription);
  }

  completeWeatherDelivery(telegramUserId: number, nextDeliveryAt: Date): void {
    this.database.prepare("UPDATE mia_weather_subscriptions SET next_delivery_at = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_user_id = ? AND status = 'active'")
      .run(nextDeliveryAt.toISOString(), telegramUserId);
  }
}
