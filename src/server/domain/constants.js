/**
 * Shared vocabulary. Every module, route, view and test MUST use these values.
 * They mirror the SQL CHECK constraints in db/migrations/0001_init.sql.
 */

export const SPACE_CATEGORY = Object.freeze({
  MEETING_ROOM: 'MEETING_ROOM',
  AUDITORIUM: 'AUDITORIUM',
  COWORKING: 'COWORKING',
});

export const SPACE_CATEGORY_LABEL = Object.freeze({
  MEETING_ROOM: 'Meeting & training room',
  AUDITORIUM: 'Auditorium',
  COWORKING: 'Co-working desk',
});

export const SPACE_CATEGORY_ORDER = Object.freeze([
  SPACE_CATEGORY.MEETING_ROOM,
  SPACE_CATEGORY.AUDITORIUM,
  SPACE_CATEGORY.COWORKING,
]);

export const SPACE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED',
});

export const SPACE_STATUS_LABEL = Object.freeze({
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
});

export const PRICING_UNIT = Object.freeze({
  HOUR: 'HOUR',
  HALF_DAY: 'HALF_DAY',
  DAY: 'DAY',
  WEEK: 'WEEK',
  MONTH: 'MONTH',
});

export const PRICING_UNIT_LABEL = Object.freeze({
  HOUR: 'per hour',
  HALF_DAY: 'per half day',
  DAY: 'per day',
  WEEK: 'per week',
  MONTH: 'per month',
});

/** Pricing units offered per category (category-specific, not one-size-fits-all). */
export const ALLOWED_PRICING_UNITS = Object.freeze({
  MEETING_ROOM: [PRICING_UNIT.HOUR, PRICING_UNIT.HALF_DAY, PRICING_UNIT.DAY],
  AUDITORIUM: [PRICING_UNIT.HOUR, PRICING_UNIT.HALF_DAY, PRICING_UNIT.DAY],
  COWORKING: [PRICING_UNIT.DAY, PRICING_UNIT.WEEK, PRICING_UNIT.MONTH],
});

export const RESERVATION_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
});

export const RESERVATION_STATUS_LABEL = Object.freeze({
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  COMPLETED: 'Completed',
});

export const BOOKING_REQUEST_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED',
  APPROVED_AWAITING_PAYMENT: 'APPROVED_AWAITING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  PAYMENT_REVIEW_REQUIRED: 'PAYMENT_REVIEW_REQUIRED',
});

export const PAYMENT_STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  UNPAID: 'UNPAID',
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  REFUNDED: 'REFUNDED',
});

/**
 * Occupancy semantics - which reservation states consume inventory.
 * CONFIRMED and COMPLETED consume inventory; CANCELLED releases it.
 * Public inquiries never consume inventory.
 */
export const CONSUMING_RESERVATION_STATUSES = Object.freeze([
  RESERVATION_STATUS.CONFIRMED,
  RESERVATION_STATUS.COMPLETED,
]);

export const OCCUPANCY_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
});

export const OCCUPANCY_SOURCE = Object.freeze({
  RESERVATION: 'RESERVATION',
  MAINTENANCE: 'MAINTENANCE',
});

export const INQUIRY_STATUS = Object.freeze({
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  CONVERTED: 'CONVERTED',
  CLOSED: 'CLOSED',
  WITHDRAWN: 'WITHDRAWN',
});

export const INQUIRY_STATUS_LABEL = Object.freeze({
  NEW: 'New',
  CONTACTED: 'Contacted',
  CONVERTED: 'Converted to reservation',
  CLOSED: 'Closed',
  WITHDRAWN: 'Withdrawn by visitor',
});

export const INQUIRY_EMAIL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
});

export const INQUIRY_EMAIL_STATUS_LABEL = Object.freeze({
  PENDING: 'Pending',
  SENT: 'Delivered',
  FAILED: 'Delivery failed',
  NOT_CONFIGURED: 'Email not configured',
});

/**
 * Application-level administrator roles. The database stores every account
 * with role = 'ADMIN' (the historical CHECK constraint) and uses
 * admin_user.is_super_admin to distinguish the two roles.
 */
export const ADMIN_ROLE = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
});

export const ADMIN_ROLE_LABEL = Object.freeze({
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
});

/** At most this many active (non-deleted) Super Admins may exist at once. */
export const MAX_SUPER_ADMINS = 3;

/** Soft-deleted accounts are purged automatically after this many days. */
export const RECYCLE_BIN_RETENTION_DAYS = 30;

export function isAdminRole(role) {
  return role === ADMIN_ROLE.SUPER_ADMIN || role === ADMIN_ROLE.ADMIN;
}

export function isSuperAdminRole(role) {
  return role === ADMIN_ROLE.SUPER_ADMIN;
}

export function adminRoleLabel(role) {
  return ADMIN_ROLE_LABEL[role] ?? String(role ?? '');
}

/** Bookable resource unit kinds. */
export const RESOURCE_KIND = Object.freeze({
  EXCLUSIVE: 'EXCLUSIVE',
  DESK: 'DESK',
});

/** The single source of truth for the engine's conflict error code. */
export const ERROR_CODE = Object.freeze({
  DOUBLE_BOOKING: 'DOUBLE_BOOKING_CONFLICT',
  VALIDATION: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL_ERROR',
});

/** Human-readable labels used across admin and public UI. */
export const AMENITY_CATALOG = Object.freeze([
  'Projector',
  'Display screen',
  'Whiteboard',
  'Video conferencing',
  'High-speed internet',
  'Power outlets',
  'Air conditioning',
  'Natural light',
  'Standing desk',
  'Ergonomic chair',
  'Stage',
  'Stage lighting',
  'Sound system',
  'Microphones',
  'Podium',
  'Accessible entrance',
  'Elevator access',
  'Parking',
  'Kitchenette',
  'Water dispenser',
  'Lockable storage',
  'Reception service',
  'Locker',
]);
