// Audit-only helper. Never falls back to backend/.env or an existing database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
process.env.NODE_TEST_CONTEXT = '1';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.WECHAT_APP_ID = '';
process.env.WECHAT_APP_SECRET = '';
process.env.WECHAT_MOCK_LOGIN = 'true';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-local-audit-'));
process.env.BOOKING_ENV_FILE = path.join(directory, 'empty.env');
fs.writeFileSync(process.env.BOOKING_ENV_FILE, '');
process.env.THERAPIST_UPLOAD_DIR = path.join(directory, 'images');
const { Pool } = require('pg');
const db = require('../../src/config/db');

async function withDatabase(run, { beforeMigration } = {}) {
  assert.ok(process.env.TEST_DATABASE_URL, 'An explicit isolated TEST_DATABASE_URL is required');
  const target = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.port, '55483');
  assert.equal(target.pathname, '/booking_audit');
  const schema = 'audit_local_' + randomUUID().replaceAll('-', '');
  const root = new Pool({ connectionString: target.href, connectionTimeoutMillis: 3000 });
  const pool = new Pool({ connectionString: target.href, application_name: schema, options: `-c search_path=${schema},public -c statement_timeout=5000 -c deadlock_timeout=100`, connectionTimeoutMillis: 3000 });
  const previous = { query: db.query, transaction: db.transaction };
  db.query = (sql, values = [], client) => (client || pool).query(sql, values);
  db.transaction = async (handler) => {
    const client = await pool.connect();
    try { return await db.withTransaction(client, handler); }
    finally { client.release(); }
  };
  let server;
  try {
    await root.query(`CREATE SCHEMA ${schema}`);
    const migrationDir = path.join(__dirname, '../../migrations');
    await db.transaction(async (client) => {
      for (const file of fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort()) {
        if (beforeMigration) await beforeMigration(file, client);
        await client.query(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
      }
    });
    const insertUser = async (name, phone, role = 'user') => (await pool.query(
      'INSERT INTO users(openid,phone,role,nickname) VALUES($1,$2,$3,$1) RETURNING *', [name, phone, role]
    )).rows[0];
    const admin = await insertUser('audit-admin', '13900000001', 'admin');
    const customer = await insertUser('audit-customer', '13900000002');
    const staff = await insertUser('audit-staff', '13900000003');
    const other = await insertUser('audit-other', '13900000004');
    await pool.query("INSERT INTO member_whitelist(phone,status,remark_name) VALUES($1,'active','审查会员')", [customer.phone]);
    const projects = (await pool.query("SELECT * FROM service_items WHERE status='active' ORDER BY id")).rows;
    const insertTherapist = async (name, user) => (await pool.query(
      "INSERT INTO therapists(name,phone,user_id,service_item_ids) VALUES($1,$2,$3,$4) RETURNING *",
      [name, user.phone, user.id, [projects[0].id]]
    )).rows[0];
    const therapistA = await insertTherapist('审查芳疗师甲', admin);
    const therapistB = await insertTherapist('审查芳疗师乙', staff);
    const { rows: [{ tomorrow }] } = await pool.query("SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date + 1)::text AS tomorrow");
    const bookingTime = ({ date = '2020-01-01', start = '09:00', end = '10:00', therapist = therapistA } = {}) =>
      ({ date, startTime: start, endTime: end, therapistId: therapist.id, serviceItemId: projects[0].id });
    const configureWeek = async (date = tomorrow, therapist = therapistA) => {
      const ranges = [{ startTime: '09:00', endTime: '12:00' }, { startTime: '13:00', endTime: '19:00' }];
      await pool.query(`INSERT INTO weekly_schedules(therapist_id,weekday,step,min_duration,ranges,service_item_ids)
        VALUES($1,extract(isodow from $2::date),30,60,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
        [therapist.id,date,JSON.stringify(ranges),projects.map(project => project.id)]);
      return bookingTime({ date, therapist });
    };
    const addAppointment = async (time, { user = customer, status = 'booked' } = {}) => (await pool.query(
      'INSERT INTO appointments(user_id,service_item_id,date,start_time,end_time,status,therapist_id,therapist_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [user.id,time.serviceItemId,time.date,time.startTime,time.endTime,status,time.therapistId,time.therapistId === therapistA.id ? therapistA.name : therapistB.name]
    )).rows[0];
    // This service captures its transaction function at factory creation.
    // Rebuild the exported instance for this case's pool; production is untouched.
    const actions = require('../../src/services/appointmentService');
    Object.assign(actions, actions.createAppointmentService({ transaction: db.transaction }));
    const portal = require('../../src/services/therapistPortalService');
    Object.assign(portal, portal.createTherapistPortalService({ transaction: db.transaction }));
    server = require('../../src/app')().listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const auth = require('../../src/services/authService');
    const userRepo = require('../../src/repositories/userRepository');
    const tokenFor = async (user) => auth.createToken(await userRepo.findById(user.id));
    async function api(route, user, method = 'GET', body, token) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token || await tokenFor(user)}` },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}), signal: AbortSignal.timeout(10000)
      });
      return { status: response.status, body: await response.json() };
    }
    return await run({ origin: `http://127.0.0.1:${server.address().port}`, pool, db, api, tokenFor, admin, customer, staff, other, therapistA, therapistB, projects, tomorrow, bookingTime, configureWeek, addAppointment });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 30));
    db.query = previous.query; db.transaction = previous.transaction;
    await pool.end();
    await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end();
  }
}

function cleanup() {
  const target = fs.realpathSync(directory);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), target);
  assert.ok(relative.startsWith('booking-local-audit-') && path.basename(relative) === relative,
    'Only this helper-created directory directly inside the temporary root may be removed');
  fs.rmSync(target, { recursive: true, force: true });
}
module.exports = { withDatabase, cleanup, directory };
