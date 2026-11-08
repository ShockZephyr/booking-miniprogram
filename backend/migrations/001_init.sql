CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('user', 'admin');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE whitelist_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE slot_status AS ENUM ('open', 'disabled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM ('booked', 'checked_in', 'cancelled', 'replaced', 'no_show');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  openid text NOT NULL UNIQUE,
  phone text NOT NULL UNIQUE,
  nickname text,
  avatar_url text,
  role user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

CREATE TABLE IF NOT EXISTS member_whitelist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL UNIQUE,
  remark_name text,
  status whitelist_status NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  duration_minutes integer NOT NULL DEFAULT 60,
  status text NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appointment_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  status slot_status NOT NULL DEFAULT 'open',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_slot_time_range CHECK (start_time < end_time),
  CONSTRAINT uniq_appointment_slot UNIQUE (date, start_time, end_time),
  CONSTRAINT no_overlapping_slots_per_date EXCLUDE USING gist (
    date WITH =,
    tsrange(date + start_time, date + end_time, '[)') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_appointment_slots_date ON appointment_slots(date);

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  slot_id uuid REFERENCES appointment_slots(id) ON DELETE SET NULL,
  service_item_id uuid NOT NULL REFERENCES service_items(id),
  date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  note text,
  status appointment_status NOT NULL DEFAULT 'booked',
  replaced_by_appointment_id uuid REFERENCES appointments(id),
  replaces_appointment_id uuid REFERENCES appointments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  checked_in_at timestamptz,
  no_show_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_appointments_user_status ON appointments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_slot ON appointments(slot_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_effective_appointment_per_slot
  ON appointments(slot_id)
  WHERE status IN ('booked', 'checked_in');

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid REFERENCES users(id),
  type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  related_appointment_id uuid REFERENCES appointments(id),
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  target_user_id uuid REFERENCES users(id),
  before jsonb,
  after jsonb,
  request_id text NOT NULL,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  effective_role text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  result text NOT NULL,
  request_id text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS http_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status_code integer NOT NULL,
  duration_ms numeric NOT NULL,
  user_id uuid REFERENCES users(id),
  effective_role text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  effective_role text,
  page text,
  message text NOT NULL,
  stack text,
  app_version text,
  system_info jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  level text NOT NULL DEFAULT 'warning',
  message text NOT NULL,
  metadata jsonb,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO service_items (name, description, duration_minutes, sort_order)
VALUES
  ('舒缓芳香护理', '低饱和香气与轻柔护理，适合日常放松。', 60, 1),
  ('深度放松课程', '针对紧绷状态的深度舒缓服务。', 60, 2),
  ('睡眠调理体验', '以薰衣草香气为主的睡眠友好课程。', 60, 3)
ON CONFLICT (name) DO NOTHING;
