/**
 * Seed data.
 *
 * Two modes:
 *   - `node src/server/db/seed.js`            catalogue only (spaces, rates, desks)
 *   - `node src/server/db/seed.js --demo`      catalogue + customers + bookings + inquiries
 *
 * Idempotent: existing spaces (matched by code) are never duplicated or
 * overwritten. Demo reservations are only created when the database has no
 * reservations at all, so re-running never piles up fake bookings.
 */
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, closeDb } from './connection.js';
import { applyMigrations } from './migrate.js';
import { businessLocalToEpoch, businessDateKey, startOfBusinessDay } from '../domain/time.js';
import { SPACE_CATEGORY, SPACE_STATUS } from '../domain/constants.js';
import { createSpace, getSpaceByCode, publishSpace, addImageRecord } from '../services/spaceService.js';
import { createCustomer } from '../services/customerService.js';
import { createReservation, createMaintenanceBlock } from '../services/bookingService.js';
import { nextReference, randomToken } from '../domain/references.js';
import { withWriteTransaction } from './connection.js';
import { hashPassword } from '../security/passwords.js';
import { recordAudit } from '../services/auditService.js';
import { ensureUploadDir, uploadDir } from '../security/uploads.js';

/* ------------------------------------------------- generated placeholder art */

/**
 * Minimal PNG encoder used to create honest placeholder artwork for seeded
 * spaces. Real photographs are uploaded by staff through the normal upload
 * flow; these are clearly synthetic gradient banners.
 */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y, width, height);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }
  const idat = deflateSync(raw, { level: 9 });

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crcTable = encodePng.crcTable ??= buildCrcTable();
    let crc = 0xFFFFFFFF;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);
    return Buffer.concat([length, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildCrcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

function gradientPng(width, height, from, to) {
  return encodePng(width, height, (x, y) => {
    const t = (x / width) * 0.6 + (y / height) * 0.4;
    return [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ];
  });
}

const PALETTES = [
  [[14, 62, 74], [42, 122, 133]],
  [[28, 52, 84], [86, 128, 156]],
  [[52, 74, 58], [118, 148, 104]],
  [[72, 54, 44], [156, 122, 92]],
];

function seedImages(db, actor, spaceId, count = 2) {
  ensureUploadDir();
  for (let i = 0; i < count; i += 1) {
    const palette = PALETTES[(spaceId + i) % PALETTES.length];
    const png = gradientPng(960, 540, palette[0], palette[1]);
    const storedName = `${Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}.png`;
    writeFileSync(join(uploadDir(), storedName), png, { mode: 0o640 });
    addImageRecord(db, {
      actor,
      spaceId,
      storedName,
      originalName: `${i === 0 ? 'cover' : `view-${i}`}.png`,
      mimeType: 'image/png',
      byteSize: png.length,
      altText: 'Generated placeholder artwork for demonstration data',
    });
  }
}

/* ------------------------------------------------------------------ catalogue */

const SPACES = [
  {
    code: 'TRC-MR-01', name: 'Baobab Meeting Room', category: SPACE_CATEGORY.MEETING_ROOM,
    short_description: 'A bright 12-seat meeting room on the second floor.',
    description: 'Baobab is our most-requested meeting room: a quiet, naturally lit space for twelve people with a wall-mounted display, video conferencing and a full-height whiteboard. Ideal for client reviews, sprint planning and half-day workshops.',
    location: 'Trace Expert City, Block A', floor: '2nd floor', capacity: 12,
    pricing_unit: 'HOUR', min_duration_minutes: 60, max_duration_minutes: 600, buffer_minutes: 15,
    open_time: '08:00', close_time: '18:00',
    amenities: ['Projector', 'Display screen', 'Whiteboard', 'Video conferencing', 'High-speed internet', 'Air conditioning', 'Power outlets'],
    attributes: { layout_options: ['Boardroom', 'U-shape', 'Classroom'], display_size_inches: 65, has_projector: true, has_whiteboard: true, conferencing: 'Zoom Rooms', internet_note: 'Wired and Wi-Fi, 100 Mbps symmetric' },
    rates: [{ unit: 'HOUR', amount_cents: 150000 }, { unit: 'HALF_DAY', amount_cents: 525000 }, { unit: 'DAY', amount_cents: 900000 }],
  },
  {
    code: 'TRC-MR-02', name: 'Acacia Training Room', category: SPACE_CATEGORY.MEETING_ROOM,
    short_description: 'A 30-seat training room configured for workshops.',
    description: 'Acacia is built for training: thirty seats in classroom layout, two projectors, a presenter station and breakout space directly outside the door. Suitable for full-day courses, certification sessions and larger team offsites.',
    location: 'Trace Expert City, Block A', floor: '3rd floor', capacity: 30,
    pricing_unit: 'HOUR', min_duration_minutes: 120, max_duration_minutes: 600, buffer_minutes: 30,
    open_time: '08:00', close_time: '18:00',
    amenities: ['Projector', 'Whiteboard', 'High-speed internet', 'Air conditioning', 'Power outlets', 'Kitchenette', 'Accessible entrance'],
    attributes: { layout_options: ['Classroom', 'Theatre', 'Cabaret'], display_size_inches: 86, has_projector: true, has_whiteboard: true, conferencing: 'Microsoft Teams', internet_note: 'Wi-Fi 6' },
    rates: [{ unit: 'HOUR', amount_cents: 220000 }, { unit: 'DAY', amount_cents: 1400000 }],
  },
  {
    code: 'TRC-AUD-01', name: 'Grand Auditorium', category: SPACE_CATEGORY.AUDITORIUM,
    short_description: 'A 420-seat auditorium with stage, lighting and full audio.',
    description: 'The Grand Auditorium seats 420 in raked seating with a 14-metre stage, professional stage lighting, a full sound system and six wireless microphones. It is used for conferences, product launches, graduations and public lectures. A technician is included for the first hour of every booking.',
    location: 'Trace Expert City, Main Hall', floor: 'Ground floor', capacity: 420,
    pricing_unit: 'HOUR', min_duration_minutes: 120, max_duration_minutes: 720, buffer_minutes: 60,
    open_time: '07:00', close_time: '21:00',
    amenities: ['Stage', 'Stage lighting', 'Sound system', 'Microphones', 'Podium', 'Projector', 'Air conditioning', 'Accessible entrance', 'Parking', 'Reception service'],
    attributes: { seating_capacity: 420, stage_width_m: 14, has_stage: true, has_lighting: true, has_audio: true, microphone_count: 6, projection: 'Dual 10k lumen', technician_included: true },
    rates: [{ unit: 'HOUR', amount_cents: 950000 }, { unit: 'HALF_DAY', amount_cents: 3200000 }, { unit: 'DAY', amount_cents: 5600000 }],
  },
  {
    code: 'TRC-CW-01', name: 'Co-working Floor — Desks', category: SPACE_CATEGORY.COWORKING,
    short_description: 'Twenty independent desks on the open co-working floor.',
    description: 'Our open co-working floor has twenty individually bookable desks with ergonomic chairs, lockable storage and access to the shared kitchenette. Book a single desk for a day, a week or a month — each reservation is allocated a specific desk so two people are never sent to the same seat.',
    location: 'Trace Expert City, Block B', floor: '1st floor', capacity: 20, desk_count: 20,
    pricing_unit: 'DAY', min_duration_minutes: 240, max_duration_minutes: 129600, buffer_minutes: 0,
    open_time: '07:00', close_time: '20:00',
    amenities: ['High-speed internet', 'Power outlets', 'Ergonomic chair', 'Locker', 'Kitchenette', 'Natural light', 'Air conditioning'],
    attributes: { desk_type: 'Hot desk', facilities: 'Lockable storage, shared kitchenette, printing on request', access_hours: '07:00–20:00, Monday to Saturday', desk_count: 20 },
    rates: [{ unit: 'DAY', amount_cents: 45000 }, { unit: 'WEEK', amount_cents: 225000 }, { unit: 'MONTH', amount_cents: 800000 }],
  },
  {
    code: 'TRC-CW-02', name: 'Quiet Pods — Focus Desks', category: SPACE_CATEGORY.COWORKING,
    short_description: 'Eight quiet-pod desks for focused individual work.',
    description: 'Eight desks inside glazed quiet pods, separated from the open floor. Booked the same way as the main co-working floor, with day, week and month rates. Best for deep-focus work and confidential calls.',
    location: 'Trace Expert City, Block B', floor: '1st floor', capacity: 8, desk_count: 8,
    pricing_unit: 'DAY', min_duration_minutes: 240, max_duration_minutes: 129600, buffer_minutes: 0,
    open_time: '07:00', close_time: '20:00',
    amenities: ['High-speed internet', 'Power outlets', 'Ergonomic chair', 'Standing desk', 'Air conditioning', 'Lockable storage'],
    attributes: { desk_type: 'Quiet pod desk', facilities: 'Acoustic lining, standing-desk converter, lockable storage', access_hours: '07:00–20:00, Monday to Saturday', desk_count: 8 },
    rates: [{ unit: 'DAY', amount_cents: 60000 }, { unit: 'WEEK', amount_cents: 300000 }, { unit: 'MONTH', amount_cents: 1050000 }],
  },
];

export function seedCatalogue(db, { actor, withImages = true } = {}) {
  const created = [];
  for (const definition of SPACES) {
    const existing = getSpaceByCode(db, definition.code);
    if (existing) { created.push({ space: existing, existed: true }); continue; }
    const space = createSpace(db, { actor, payload: definition });
    if (withImages) seedImages(db, actor, space.id, 2);
    const published = publishSpace(db, { actor, spaceId: space.id });
    created.push({ space: published, existed: false });
  }
  return created;
}

/* ------------------------------------------------------------------- demo data */

export function seedDemoContent(db, { actor } = {}) {
  if (db.prepare('SELECT COUNT(*) AS c FROM reservation').get().c > 0) {
    return { skipped: true, reason: 'reservations already exist' };
  }

  const customers = [
    { full_name: 'Hanna Bekele', email: 'hanna.bekele@example.com', phone: '+251 911 204 118', organization: 'Addis Digital Labs' },
    { full_name: 'Samuel Girma', email: 'samuel.girma@example.com', phone: '+251 911 887 340', organization: 'Ethio Cloud Services' },
    { full_name: 'Marta Tesfaye', email: 'marta.tesfaye@example.com', phone: '+251 922 556 703', organization: 'Trace Skills Institute' },
    { full_name: 'Yonas Alemu', email: 'yonas.alemu@example.com', phone: '+251 913 992 641', organization: 'Independent' },
    { full_name: 'Liya Haile', email: 'liya.haile@example.com', phone: '+251 944 118 205', organization: 'Nile Consult' },
  ].map((payload) => createCustomer(db, { actor, payload }));

  const todayKey = businessDateKey(Date.now());
  const plusDays = (days) => {
    const base = startOfBusinessDay(Date.now());
    return businessDateKey(base + days * 86400000);
  };

  const room = getSpaceByCode(db, 'TRC-MR-01');
  const training = getSpaceByCode(db, 'TRC-MR-02');
  const auditorium = getSpaceByCode(db, 'TRC-AUD-01');
  const desks = getSpaceByCode(db, 'TRC-CW-01');

  const bookings = [
    { space: room, customer: customers[0], date: todayKey, from: '09:00', to: '11:00', purpose: 'Sprint review', attendees: 9 },
    { space: room, customer: customers[1], date: todayKey, from: '14:00', to: '16:00', purpose: 'Client discovery session', attendees: 6 },
    { space: training, customer: customers[2], date: plusDays(1), from: '09:00', to: '16:00', purpose: 'Data fundamentals training', attendees: 26, billingUnit: 'DAY' },
    { space: auditorium, customer: customers[4], date: plusDays(3), from: '09:00', to: '18:00', purpose: 'Nile Consult annual conference', attendees: 380, billingUnit: 'DAY' },
    { space: room, customer: customers[3], date: plusDays(2), from: '10:00', to: '12:00', purpose: 'Vendor negotiation', attendees: 4 },
    { space: desks, customer: customers[1], date: plusDays(1), from: '07:00', to: '20:00', purpose: 'Team hot-desking — 4 desks', unitCount: 4, billingUnit: 'DAY' },
  ];

  const made = [];
  for (const entry of bookings) {
    const result = createReservation(db, {
      actor,
      spaceId: entry.space.id,
      customerId: entry.customer.id,
      startAt: businessLocalToEpoch(entry.date, entry.from),
      endAt: businessLocalToEpoch(entry.date, entry.to),
      unitCount: entry.unitCount ?? 1,
      attendees: entry.attendees ?? null,
      purpose: entry.purpose,
      billingUnit: entry.billingUnit ?? null,
    });
    made.push(result.reservation);
  }

  // A completed booking in the past, to exercise the COMPLETED status path.
  const pastDate = plusDays(-7);
  const past = createReservation(db, {
    actor,
    spaceId: room.id,
    customerId: customers[0].id,
    startAt: businessLocalToEpoch(pastDate, '09:00'),
    endAt: businessLocalToEpoch(pastDate, '11:00'),
    attendees: 7,
    purpose: 'Retrospective',
  });

  // Maintenance: the auditorium is dark for rigging next week.
  createMaintenanceBlock(db, {
    actor,
    spaceId: auditorium.id,
    startAt: businessLocalToEpoch(plusDays(7), '07:00'),
    endAt: businessLocalToEpoch(plusDays(7), '21:00'),
    reason: 'Stage rigging inspection and lighting service',
  });

  // An open inquiry, and one whose notification could not be delivered.
  const inquiryRows = [
    {
      space: auditorium, name: 'Dawit Mekonnen', email: 'dawit.mekonnen@example.com',
      phone: '+251 911 665 220', organization: 'Rift Valley Media',
      start: businessLocalToEpoch(plusDays(10), '09:00'), end: businessLocalToEpoch(plusDays(10), '17:00'),
      attendees: 300, message: 'We would like to host a product launch for around 300 guests. Please advise on staging and AV support.',
      status: 'NEW', emailStatus: 'NOT_CONFIGURED',
    },
    {
      space: room, name: 'Selam Abebe', email: 'selam.abebe@example.com',
      phone: '+251 922 401 887', organization: 'Bright Path Consulting',
      start: businessLocalToEpoch(plusDays(4), '13:00'), end: businessLocalToEpoch(plusDays(4), '15:00'),
      attendees: 10, message: 'Half-day strategy session. We need a whiteboard and video conferencing.',
      status: 'CONTACTED', emailStatus: 'NOT_CONFIGURED',
    },
  ];

  withWriteTransaction(db, () => {
    for (const row of inquiryRows) {
      const reference = nextReference(db, 'inquiry');
      const now = Date.now();
      db.prepare(`INSERT INTO inquiry
          (reference, space_id, customer_name, email, email_normalized, phone, organization,
           requested_start_at, requested_end_at, attendees, desk_quantity, message, status,
           withdraw_token_hash, email_status, email_error, email_attempted_at, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          reference, row.space.id, row.name, row.email, row.email.toLowerCase(), row.phone,
          row.organization, row.start, row.end, row.attendees, null, row.message, row.status,
          hashTokenForSeed(randomToken(24)), row.emailStatus,
          row.emailStatus === 'NOT_CONFIGURED' ? 'SMTP is not configured (SMTP_HOST is unset).' : null,
          now, now, now,
        );
    }
  });

  return { skipped: false, reservations: made.length + 1, pastReservation: past.reservation.reference, customers: customers.length };
}

function hashTokenForSeed(token) {
  // Same derivation as inquiryService: sha256 of the raw token.
  return createHash('sha256').update(String(token)).digest('hex');
}

/* ---------------------------------------------------------------------- main */

export function maybeSeedDemoData(db) {
  const existingSpaces = db.prepare('SELECT COUNT(*) AS c FROM space').get().c;
  if (existingSpaces > 0) {
    console.log('[seed] spaces already present; demo seed skipped');
    return { skipped: true };
  }
  const actor = ensureSeedActor(db);
  seedCatalogue(db, { actor });
  seedDemoContent(db, { actor });
  console.log('[seed] demo catalogue, customers, reservations and inquiries created');
  return { skipped: false };
}

function ensureSeedActor(db) {
  const existing = db.prepare("SELECT * FROM admin_user WHERE role = 'ADMIN' ORDER BY id LIMIT 1").get();
  if (existing) return { id: existing.id, label: `${existing.display_name} (${existing.role})`, role: existing.role };

  const email = process.env.NAGARO_DEMO_ADMIN_EMAIL ?? 'admin@nagaro.local';
  const password = process.env.NAGARO_DEMO_ADMIN_PASSWORD ?? 'NagaroDemo2026';
  const now = Date.now();
  const info = db.prepare(`INSERT INTO admin_user
      (email, password_hash, display_name, role, is_active, created_at, updated_at)
      VALUES (?,?,?,'ADMIN',1,?,?)`)
    .run(email, hashPassword(password), 'Demo Administrator', now, now);
  const id = Number(info.lastInsertRowid);
  recordAudit(db, {
    actorAdminUserId: id, actorLabel: 'seed',
    action: 'admin_user.created', entityType: 'admin_user', entityId: id,
    summary: `Seeded demonstration administrator ${email}`,
  });
  console.log(`[seed] created demonstration administrator ${email}`);
  return { id, label: 'Demo Administrator (ADMIN)', role: 'ADMIN' };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/seed.js');
if (invokedDirectly) {
  const db = getDb();
  applyMigrations(db);
  const actor = ensureSeedActor(db);
  const catalogue = seedCatalogue(db, { actor });
  const published = catalogue.filter((c) => c.space.status === SPACE_STATUS.PUBLISHED).length;
  console.log(`Catalogue ready: ${catalogue.length} spaces (${published} published).`);
  if (process.argv.includes('--demo')) {
    const demo = seedDemoContent(db, { actor });
    console.log(demo.skipped ? `Demo reservations skipped: ${demo.reason}` : `Demo content: ${demo.reservations} reservations, ${demo.customers} customers.`);
  }
  console.log(`Database: ${process.env.NAGARO_DB_PATH ?? 'data/nagaro.db'}`);
  closeDb();
}

export { encodePng, gradientPng, existsSync, mkdirSync };
