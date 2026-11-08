const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const migrationsDir = path.join(__dirname, "../migrations");
const migration = fs.readFileSync(path.join(migrationsDir, "001_init.sql"), "utf8");
const allMigrations = fs.readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => fs.readFileSync(path.join(migrationsDir, file), "utf8"))
  .join("\n");

test("users.role only allows user and admin", () => {
  assert.match(migration, /CREATE TYPE user_role AS ENUM \('user', 'admin'\)/);
  assert.doesNotMatch(migration, /'member'/);
});

test("member whitelist phone is unique and active status drives membership", () => {
  assert.match(migration, /member_whitelist[\s\S]*phone text NOT NULL UNIQUE/);
  assert.match(migration, /CREATE TYPE whitelist_status AS ENUM \('active', 'inactive'\)/);
});

test("slot uniqueness and active appointment uniqueness are enforced in PostgreSQL", () => {
  assert.match(migration, /CONSTRAINT uniq_appointment_slot UNIQUE \(date, start_time, end_time\)/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS btree_gist/);
  assert.match(allMigrations, /CONSTRAINT no_overlapping_slots_per_date EXCLUDE USING gist/);
  assert.match(allMigrations, /tsrange\(date \+ start_time, date \+ end_time, '\[\)'\) WITH &&/);
  assert.match(migration, /slot_id uuid REFERENCES appointment_slots\(id\) ON DELETE SET NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_effective_appointment_per_slot/);
  assert.match(migration, /WHERE status IN \('booked', 'checked_in'\)/);
});

test("appointment state machine includes no_show and replacement fields", () => {
  assert.match(migration, /CREATE TYPE appointment_status AS ENUM \('booked', 'checked_in', 'cancelled', 'replaced', 'no_show'\)/);
  assert.match(migration, /replaced_by_appointment_id uuid REFERENCES appointments\(id\)/);
  assert.match(migration, /replaces_appointment_id uuid REFERENCES appointments\(id\)/);
  assert.match(migration, /no_show_at timestamptz/);
});

test("audit, client error, request and alert observability tables exist", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS audit_logs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS client_errors/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS http_request_logs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS alerts/);
});

test("orphaned images are retained before cleanup", () => {
  assert.match(allMigrations, /CREATE TABLE IF NOT EXISTS image_cleanup_candidates/);
  assert.match(allMigrations, /first_seen_orphan_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test("recycle bin records keep stable ordering metadata", () => {
  assert.match(allMigrations, /ALTER TABLE therapists ADD COLUMN IF NOT EXISTS sort_order integer/);
  assert.match(allMigrations, /idx_therapists_status_sort_order/);
  assert.match(allMigrations, /ADD COLUMN IF NOT EXISTS purged_at timestamptz/);
  assert.match(allMigrations, /idx_service_items_recycle_due/);
  assert.match(allMigrations, /idx_therapists_recycle_due/);
});

test("production startup applies database migrations before serving traffic", () => {
  const backendPackage = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const ecosystem = fs.readFileSync(path.join(__dirname, "../../ecosystem.config.js"), "utf8");
  assert.equal(backendPackage.scripts.prestart, "npm run migrate");
  assert.match(ecosystem, /script:\s*["']npm["']/);
  assert.match(ecosystem, /args:\s*["']start["']/);
});

test("image cleanup preserves files referenced by active and recycled records", () => {
  const cleanup = fs.readFileSync(path.join(__dirname, "../src/repositories/imageReferenceRepository.js"), "utf8");
  assert.match(cleanup, /SELECT image_url FROM home_covers/);
  assert.match(cleanup, /SELECT image_url FROM therapists WHERE image_url <> ''/);
  assert.match(cleanup, /SELECT image_url FROM service_items WHERE image_url <> ''/);
  assert.doesNotMatch(cleanup, /FROM therapists WHERE status = 'active'/);
  assert.doesNotMatch(cleanup, /FROM service_items WHERE status = 'active'/);
});

test("therapist accounts link by private phone without adding a third user role", () => {
  assert.match(allMigrations, /ADD COLUMN IF NOT EXISTS phone text/);
  assert.match(allMigrations, /ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(allMigrations, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_therapist_phone/);
  assert.match(allMigrations, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_therapist_user/);
  assert.match(allMigrations, /phone ~ '\^1\[3-9\]\[0-9\]\{9\}\$'/);
});

test("legacy notification history schema remains readable for old backups", () => {
  assert.match(allMigrations, /ADD COLUMN IF NOT EXISTS recipient_role text/);
  assert.match(allMigrations, /ADD COLUMN IF NOT EXISTS template_data jsonb/);
  assert.match(allMigrations, /ADD COLUMN IF NOT EXISTS delivery_status text/);
  assert.match(allMigrations, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_dedup_key/);
  assert.match(allMigrations, /CREATE INDEX IF NOT EXISTS idx_notifications_delivery_due/);
});
