import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withWriteTransaction } from '../db/connection.js';
import {
  BOOKING_REQUEST_STATUS, PAYMENT_STATUS, OCCUPANCY_SOURCE, OCCUPANCY_STATUS,
  SPACE_CATEGORY, isAdminRole,
} from '../domain/constants.js';
import { conflict, notFound, validationError } from '../domain/errors.js';
import { nextReference } from '../domain/references.js';
import { normalizeEmail, optionalPhone, requiredEmail, requiredString, asInteger, asTrimmedString } from '../domain/validation.js';
import { allocateUnits, assertBookingRules } from './availabilityService.js';
import { loadRates, quote } from './pricingService.js';
import { resolveOrCreateCustomerInTransaction } from './customerService.js';
import { recordAudit } from './auditService.js';
import {
  afterBookingRequestCancelled, afterBookingRequestConfirmed, afterBookingRequestCreated,
} from './notificationHooks.js';

const ACTIVE_REQUEST = [BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT, BOOKING_REQUEST_STATUS.PAYMENT_REVIEW_REQUIRED];

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function md5Upper(value) {
  return createHash('md5').update(String(value), 'utf8').digest('hex').toUpperCase();
}

function publicSystemActor(db) {
  let row = db.prepare('SELECT id, display_name FROM admin_user WHERE COALESCE(is_system, 0) = 1 ORDER BY id LIMIT 1').get();
  if (!row) {
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO admin_user
      (email,password_hash,display_name,role,is_active,created_at,updated_at,is_system)
      VALUES (?,?,?,?,?,?,?,1)`).run('public-booking@system.nagaro','!NO_LOGIN_PUBLIC_BOOKING_PRINCIPAL!','Public booking workflow','ADMIN',0,now,now);
    row = db.prepare('SELECT id, display_name FROM admin_user WHERE COALESCE(is_system, 0) = 1 ORDER BY id LIMIT 1').get();
  }
  if (!row) throw new Error('Public booking principal is unavailable.');
  return { id: Number(row.id), label: row.display_name };
}

function hydrate(db, row, { includePrivate = false } = {}) {
  if (!row) return null;
  const obligation = db.prepare('SELECT * FROM payment_obligation WHERE booking_request_id = ?').get(row.id);
  const latestAttempt = db.prepare('SELECT order_id,amount_cents,advance_cents,status,provider_payment_id,provider_method,provider_status_code,updated_at FROM payment_attempt WHERE booking_request_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
  const value = {
    reference: row.reference,
    status: row.status,
    paymentStatus: row.payment_status,
    spaceCode: row.space_code,
    spaceName: row.space_name,
    startAt: Number(row.start_at), endAt: Number(row.end_at),
    unitCount: Number(row.unit_count), attendees: row.attendees === null ? null : Number(row.attendees),
    purpose: row.purpose,
    billingUnit: row.billing_unit, billingQuantity: Number(row.billing_quantity),
    rateCents: Number(row.rate_cents), venueTotalCents: Number(row.venue_total_cents), currency: row.currency,
    holdExpiresAt: row.hold_expires_at === null ? null : Number(row.hold_expires_at),
    rejectionReason: row.rejection_reason,
    reservationReference: row.reservation_reference ?? null,
    payment: obligation ? {
      bookingFeeCents: Number(obligation.booking_fee_cents),
      advancePaidCents: Number(obligation.advance_paid_cents ?? 0),
      venueTotalCents: Number(obligation.venue_total_cents),
      remainingBalanceCents: Number(obligation.remaining_balance_cents),
      currency: obligation.currency,
      latestAttempt: latestAttempt ? {
        orderId: latestAttempt.order_id, amountCents: Number(latestAttempt.amount_cents),
        advanceCents: Number(latestAttempt.advance_cents ?? 0), status: latestAttempt.status,
        paymentId: latestAttempt.provider_payment_id, method: latestAttempt.provider_method,
        statusCode: latestAttempt.provider_status_code, updatedAt: Number(latestAttempt.updated_at),
      } : null,
    } : null,
  };
  if (includePrivate) value.customer = { fullName: row.customer_name, email: row.email, phone: row.phone, organization: row.organization };
  return value;
}

const SELECT = `SELECT br.*, s.code AS space_code, s.name AS space_name,
  r.reference AS reservation_reference
  FROM booking_request br JOIN space s ON s.id=br.space_id
  LEFT JOIN reservation r ON r.id=br.reservation_id`;

export function expireBookingHolds(db, now = Date.now()) {
  return withWriteTransaction(db, () => {
    const rows = db.prepare(`SELECT id FROM booking_request WHERE status = ? AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?`)
      .all(BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT, now);
    for (const row of rows) {
      db.prepare(`UPDATE occupancy SET status='RELEASED',released_at=? WHERE id IN
        (SELECT occupancy_id FROM booking_hold_claim WHERE booking_request_id=? AND status='ACTIVE') AND status='ACTIVE'`).run(now,row.id);
      db.prepare("UPDATE booking_hold_claim SET status='RELEASED',released_at=? WHERE booking_request_id=? AND status='ACTIVE'").run(now,row.id);
      db.prepare('UPDATE booking_request SET status=?,updated_at=? WHERE id=?').run(BOOKING_REQUEST_STATUS.EXPIRED,now,row.id);
    }
    return rows.length;
  });
}

export function createBookingRequest(db, input = {}) {
  const space = db.prepare("SELECT * FROM space WHERE id=? AND status='PUBLISHED'").get(Number(input.spaceId));
  if (!space) throw validationError('Choose a published space.', { space: 'Choose a published space.' });
  const startAt = Number(input.startAt); const endAt = Number(input.endAt); const now = Number(input.now ?? Date.now());
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt <= now || endAt <= startAt) throw validationError('Choose a valid future date and time.');
  const unitCount = space.category === SPACE_CATEGORY.COWORKING ? asInteger(input.unitCount,{field:'unit_count',min:1,required:true}) : 1;
  const attendees = asInteger(input.attendees,{field:'attendees',min:1,fallback:null});
  assertBookingRules(space,{startAt,endAt},attendees);
  const customerName = requiredString(input.customer?.fullName,{field:'full_name',max:160});
  const email = requiredEmail(input.customer?.email);
  const phone = optionalPhone(input.customer?.phone);
  const organization = asTrimmedString(input.customer?.organization,{field:'organization',max:160});
  const purpose = asTrimmedString(input.purpose,{field:'purpose',max:2000});
  const priced = quote({space,rates:loadRates(db,space.id),startAt,endAt,unitCount,billingUnit:input.billingUnit || null});
  const idempotencyKey = String(input.idempotencyKey ?? '').trim() || null;
  const manageToken = randomBytes(32).toString('base64url');
  const result = withWriteTransaction(db, () => {
    if (idempotencyKey) {
      const existing = db.prepare(`${SELECT} WHERE br.idempotency_key=?`).get(idempotencyKey);
      if (existing) return { request: hydrate(db,existing), manageToken:null, idempotent:true };
    }
    const reference = nextReference(db,'booking_request',now);
    const info = db.prepare(`INSERT INTO booking_request
      (reference,space_id,status,payment_status,customer_name,email,email_normalized,phone,organization,start_at,end_at,unit_count,attendees,purpose,billing_unit,billing_quantity,rate_cents,venue_total_cents,currency,manage_token_hash,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      reference,space.id,BOOKING_REQUEST_STATUS.REQUESTED,PAYMENT_STATUS.UNPAID,customerName,email,normalizeEmail(email),phone,organization,startAt,endAt,unitCount,attendees,purpose,priced.billingUnit,priced.billingQuantity,priced.rateCents,priced.totalCents,priced.currency,sha256(manageToken),idempotencyKey,now,now);
    recordAudit(db,{actorLabel:'public visitor',action:'booking_request.created',entityType:'booking_request',entityId:info.lastInsertRowid,summary:`Created ${reference}`,details:{spaceId:space.id,startAt,endAt,unitCount}});
    return {request:hydrate(db,db.prepare(`${SELECT} WHERE br.id=?`).get(Number(info.lastInsertRowid))),manageToken,idempotent:false};
  });
  if (!result.idempotent && input.notify !== false) {
    afterBookingRequestCreated(db, { reference: result.request.reference, now });
  }
  return result;
}

function loadForCapability(db, reference, token) {
  const candidate = String(token ?? '').trim();
  if (candidate.length < 20) throw notFound('Booking request not found.');
  const row = db.prepare(`${SELECT} WHERE br.reference=? AND br.manage_token_hash=?`).get(String(reference??'').trim().toUpperCase(),sha256(candidate));
  if (!row) throw notFound('Booking request not found.');
  return row;
}

export function getBookingRequest(db, capability) {
  expireBookingHolds(db);
  return hydrate(db,loadForCapability(db,capability.reference,capability.token));
}

export function cancelBookingRequest(db,{reference,token,reason=null,now=Date.now()}={}){
  const row=loadForCapability(db,reference,token);
  if(![BOOKING_REQUEST_STATUS.REQUESTED,BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT].includes(row.status))throw conflict('This request can no longer be cancelled online.');
  const result = withWriteTransaction(db,()=>{
    db.prepare(`UPDATE occupancy SET status='RELEASED',released_at=? WHERE id IN (SELECT occupancy_id FROM booking_hold_claim WHERE booking_request_id=? AND status='ACTIVE') AND status='ACTIVE'`).run(now,row.id);
    db.prepare("UPDATE booking_hold_claim SET status='RELEASED',released_at=? WHERE booking_request_id=? AND status='ACTIVE'").run(now,row.id);
    const note=reason?String(reason).trim().slice(0,1000):'Cancelled by visitor through the private request link.';
    db.prepare('UPDATE booking_request SET status=?,cancelled_at=?,cancellation_reason=?,updated_at=? WHERE id=?').run(BOOKING_REQUEST_STATUS.CANCELLED,now,note,now,row.id);
    recordAudit(db,{actorLabel:'public visitor',action:'booking_request.cancelled',entityType:'booking_request',entityId:row.id,summary:`Cancelled ${row.reference}`,details:{reason:note}});
    return hydrate(db,db.prepare(`${SELECT} WHERE br.id=?`).get(row.id));
  });
  afterBookingRequestCancelled(db, { reference: result.reference, now });
  return result;
}

function feeSnapshot(policy, total) {
  if (!policy || policy.mode === 'DISABLED') return { mode:'DISABLED', value:0, fee:0 };
  if (policy.mode === 'FIXED') return { mode:'FIXED', value:Number(policy.fixed_cents), fee:Number(policy.fixed_cents) };
  const bps = Number(policy.percentage_bps);
  return { mode:'PERCENTAGE', value:bps, fee:Math.max(0,Math.round(Number(total)*bps/10000)) };
}

function confirmFromHold(db, row, now) {
  const actor = publicSystemActor(db);
  const customer = resolveOrCreateCustomerInTransaction(db,{actor,payload:{full_name:row.customer_name,email:row.email,phone:row.phone,organization:row.organization}});
  const reference = nextReference(db,'reservation',now);
  const info = db.prepare(`INSERT INTO reservation
    (reference,space_id,customer_id,status,start_at,end_at,unit_count,attendees,purpose,internal_notes,billing_unit,billing_quantity,rate_cents,total_cents,currency,idempotency_key,created_by,created_at,updated_by,updated_at,booking_channel,manage_token_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(reference,row.space_id,customer.id,'CONFIRMED',row.start_at,row.end_at,row.unit_count,row.attendees,row.purpose,null,row.billing_unit,row.billing_quantity,row.rate_cents,row.venue_total_cents,row.currency,`booking-request:${row.id}`,actor.id,now,actor.id,now,'PUBLIC',row.manage_token_hash);
  const reservationId = Number(info.lastInsertRowid);
  const claims = db.prepare(`SELECT h.*,o.resource_unit_id,o.space_id,o.start_at,o.end_at
    FROM booking_hold_claim h JOIN occupancy o ON o.id=h.occupancy_id
    WHERE h.booking_request_id=? AND h.status='ACTIVE' AND o.status='ACTIVE'
    ORDER BY o.resource_unit_id`).all(row.id);
  db.prepare(`UPDATE occupancy SET status='RELEASED',released_at=? WHERE id IN
    (SELECT occupancy_id FROM booking_hold_claim WHERE booking_request_id=? AND status='ACTIVE') AND status='ACTIVE'`).run(now,row.id);
  db.prepare("UPDATE booking_hold_claim SET status='RELEASED',released_at=? WHERE booking_request_id=? AND status='ACTIVE'").run(now,row.id);
  const insert = db.prepare(`INSERT INTO occupancy (resource_unit_id,space_id,start_at,end_at,status,source,reservation_id,created_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const claim of claims) insert.run(claim.resource_unit_id,row.space_id,row.start_at,row.end_at,OCCUPANCY_STATUS.ACTIVE,OCCUPANCY_SOURCE.RESERVATION,reservationId,now);
  db.prepare('UPDATE booking_request SET status=?,payment_status=?,reservation_id=?,confirmed_at=?,updated_at=? WHERE id=?')
    .run(BOOKING_REQUEST_STATUS.CONFIRMED,Number(row.booking_fee_cents ?? 0)>0?PAYMENT_STATUS.PAID:PAYMENT_STATUS.NOT_REQUIRED,reservationId,now,now,row.id);
  recordAudit(db,{actorAdminUserId:actor.id,actorLabel:actor.label,action:'booking_request.confirmed',entityType:'booking_request',entityId:row.id,summary:`Confirmed ${row.reference} as ${reference}`});
  return reservationId;
}

export function approveBookingRequest(db,{actor,requestId,now=Date.now()}={}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  const result = withWriteTransaction(db,()=>{
    const row=db.prepare('SELECT * FROM booking_request WHERE id=?').get(Number(requestId));
    if(!row) throw notFound('Booking request not found.');
    if(row.status!==BOOKING_REQUEST_STATUS.REQUESTED) throw conflict('Only a new request can be approved.');
    const space=db.prepare('SELECT * FROM space WHERE id=?').get(row.space_id);
    const allocation=allocateUnits(db,{spaceId:row.space_id,startAt:row.start_at,endAt:row.end_at,requiredCount:row.unit_count,bufferMinutes:space.buffer_minutes??0});
    const policy=db.prepare('SELECT * FROM booking_fee_policy WHERE id=1').get();
    const snapshot=feeSnapshot(policy,row.venue_total_cents);
    const expiresAt=now+Number(policy?.payment_window_minutes??120)*60000;
    const occupancyInsert=db.prepare(`INSERT INTO occupancy (resource_unit_id,space_id,start_at,end_at,status,source,reservation_id,maintenance_block_id,created_at) VALUES (?,?,?,?,?,'MAINTENANCE',NULL,NULL,?)`);
    const holdInsert=db.prepare(`INSERT INTO booking_hold_claim (booking_request_id,occupancy_id,status,expires_at,created_at) VALUES (?,?,'ACTIVE',?,?)`);
    for(const unit of allocation.units){const occupancy=occupancyInsert.run(unit.id,row.space_id,row.start_at,row.end_at,'ACTIVE',now);holdInsert.run(row.id,Number(occupancy.lastInsertRowid),expiresAt,now);}
    const obligation=db.prepare(`INSERT INTO payment_obligation (booking_request_id,policy_mode,policy_value,booking_fee_cents,venue_total_cents,remaining_balance_cents,currency,created_at) VALUES (?,?,?,?,?,?,?,?)`);
    obligation.run(row.id,snapshot.mode,snapshot.value,snapshot.fee,row.venue_total_cents,Math.max(0,row.venue_total_cents-snapshot.fee),row.currency,now);
    db.prepare('UPDATE booking_request SET status=?,payment_status=?,approved_by=?,approved_at=?,hold_expires_at=?,updated_at=? WHERE id=?')
      .run(snapshot.fee>0?BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT:BOOKING_REQUEST_STATUS.CONFIRMED,snapshot.fee>0?PAYMENT_STATUS.UNPAID:PAYMENT_STATUS.NOT_REQUIRED,actor.id,now,expiresAt,now,row.id);
    if(snapshot.fee===0) confirmFromHold(db,{...row,booking_fee_cents:0},now);
    recordAudit(db,{actorAdminUserId:actor.id,actorLabel:actor.label,action:'booking_request.approved',entityType:'booking_request',entityId:row.id,summary:`Approved ${row.reference}`,details:{bookingFeeCents:snapshot.fee,holdExpiresAt:expiresAt}});
    return hydrate(db,db.prepare(`${SELECT} WHERE br.id=?`).get(row.id),{includePrivate:true});
  });
  if (result.status === BOOKING_REQUEST_STATUS.CONFIRMED && result.reservationReference) {
    afterBookingRequestConfirmed(db, {
      reference: result.reference,
      now,
      excludeAdminUserId: actor.id,
    });
  }
  return result;
}

/**
 * Customer-facing checkout with no staff approval step.
 *
 * A disabled fee policy confirms the reservation immediately. When a
 * registration fee is enabled, the same transaction creates an inventory
 * hold and moves checkout straight to payment. In both cases allocation runs
 * under the canonical write transaction and database overlap constraint.
 */
export function createSelfServiceBooking(db, input = {}) {
  const created = createBookingRequest(db, { ...input, notify: false });
  if (created.request.status !== BOOKING_REQUEST_STATUS.REQUESTED) return created;

  const row = db.prepare('SELECT id FROM booking_request WHERE reference=?').get(created.request.reference);
  try {
    approveBookingRequest(db, {
      actor: publicSystemActor(db),
      requestId: row?.id,
      now: Number(input.now ?? Date.now()),
    });
  } catch (error) {
    // A simultaneous checkout may win the allocation between the public
    // availability preview and this final write. Keep the losing attempt out
    // of the staff approval queue and return the canonical conflict instead.
    if (!created.idempotent && row?.id) {
      withWriteTransaction(db, () => {
        const now = Number(input.now ?? Date.now());
        db.prepare(`UPDATE booking_request
          SET status=?,rejected_at=?,rejection_reason=?,updated_at=?
          WHERE id=? AND status=?`).run(
          BOOKING_REQUEST_STATUS.REJECTED,
          now,
          'The selected time became unavailable during checkout.',
          now,
          row.id,
          BOOKING_REQUEST_STATUS.REQUESTED,
        );
      });
    }
    throw error;
  }

  const checkout = db.prepare(`${SELECT} WHERE br.id=?`).get(row.id);
  return {
    request: hydrate(db, checkout),
    manageToken: created.manageToken,
    idempotent: created.idempotent,
  };
}

export function rejectBookingRequest(db,{actor,requestId,reason,now=Date.now()}={}) {
  const why=requiredString(reason,{field:'reason',max:1000});
  if(!actor?.id) throw validationError('An authenticated staff actor is required.');
  return withWriteTransaction(db,()=>{
    const row=db.prepare('SELECT * FROM booking_request WHERE id=?').get(Number(requestId));
    if(!row) throw notFound('Booking request not found.');
    if(row.status!==BOOKING_REQUEST_STATUS.REQUESTED) throw conflict('Only a new request can be rejected.');
    db.prepare('UPDATE booking_request SET status=?,rejected_by=?,rejected_at=?,rejection_reason=?,updated_at=? WHERE id=?').run(BOOKING_REQUEST_STATUS.REJECTED,actor.id,now,why,now,row.id);
    recordAudit(db,{actorAdminUserId:actor.id,actorLabel:actor.label,action:'booking_request.rejected',entityType:'booking_request',entityId:row.id,summary:`Rejected ${row.reference}`,details:{reason:why}});
    return hydrate(db,db.prepare(`${SELECT} WHERE br.id=?`).get(row.id),{includePrivate:true});
  });
}

export function listBookingRequests(db,{status=null,limit=100}={}) {
  expireBookingHolds(db);
  const rows=status?db.prepare(`${SELECT} WHERE br.status=? ORDER BY br.created_at DESC LIMIT ?`).all(status,limit):db.prepare(`${SELECT} ORDER BY br.created_at DESC LIMIT ?`).all(limit);
  return rows.map(row=>hydrate(db,row,{includePrivate:true}));
}

export function getBookingFeePolicy(db){
  const row=db.prepare('SELECT * FROM booking_fee_policy WHERE id=1').get();
  return {mode:row.mode,fixedCents:Number(row.fixed_cents),percentageBps:Number(row.percentage_bps),paymentWindowMinutes:Number(row.payment_window_minutes),updatedAt:Number(row.updated_at)};
}

export function updateBookingFeePolicy(db,{actor,mode,fixedCents=0,percentageBps=0,paymentWindowMinutes=120,now=Date.now()}={}){
  if(!actor?.id||!isAdminRole(actor.role))throw validationError('An administrator is required.');
  const selected=String(mode??'');if(!['DISABLED','FIXED','PERCENTAGE'].includes(selected))throw validationError('Choose a valid fee mode.');
  const fixed=Number(fixedCents),bps=Number(percentageBps),window=Number(paymentWindowMinutes);
  if(!Number.isInteger(fixed)||fixed<0||!Number.isInteger(bps)||bps<0||bps>10000||!Number.isInteger(window)||window<5||window>10080)throw validationError('Registration fee policy values are outside the supported range.');
  return withWriteTransaction(db,()=>{db.prepare('UPDATE booking_fee_policy SET mode=?,fixed_cents=?,percentage_bps=?,payment_window_minutes=?,updated_by=?,updated_at=? WHERE id=1').run(selected,fixed,bps,window,actor.id,now);recordAudit(db,{actorAdminUserId:actor.id,actorLabel:actor.label,action:'booking_fee_policy.updated',entityType:'booking_fee_policy',entityId:1,summary:`Registration fee policy set to ${selected}`,details:{fixedCents:fixed,percentageBps:bps,paymentWindowMinutes:window}});return getBookingFeePolicy(db);});
}

export function createPayHereCheckout(db,{reference,token,config,advanceCents=0,now=Date.now()}={}) {
  expireBookingHolds(db,now);
  return withWriteTransaction(db,()=>{
    const row=loadForCapability(db,reference,token);
    if(row.status!==BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT) throw conflict('This request is not awaiting payment.');
    const obligation=db.prepare('SELECT * FROM payment_obligation WHERE booking_request_id=?').get(row.id);
    if(!obligation||Number(obligation.booking_fee_cents)<=0) throw conflict('No registration fee is due.');
    const advance=Number(advanceCents??0);
    const availableBalance=Number(obligation.remaining_balance_cents);
    if(!Number.isSafeInteger(advance)||advance<0) throw validationError('Choose a valid optional advance.',{advanceCents:'Enter an advance amount in whole cents.'});
    if(advance>availableBalance) throw validationError('The optional advance cannot exceed the remaining venue balance.',{advanceCents:'Reduce the advance to the remaining venue balance or less.'});
    const merchantId=String(config?.merchantId??'').trim(); const merchantSecret=String(config?.merchantSecret??'').trim();
    if(!merchantId||!merchantSecret) throw conflict('Online payment is not configured yet.');
    const attemptNo=Number(db.prepare('SELECT COUNT(*) AS c FROM payment_attempt WHERE booking_request_id=?').get(row.id)?.c??0)+1;
    const amountCents=Number(obligation.booking_fee_cents)+advance;
    const orderId=`${row.reference}-${attemptNo}`; const amount=(amountCents/100).toFixed(2); const currency=obligation.currency;
    const attempt=db.prepare(`INSERT INTO payment_attempt (booking_request_id,obligation_id,order_id,amount_cents,advance_cents,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'CREATED',?,?)`).run(row.id,obligation.id,orderId,amountCents,advance,currency,now,now);
    const base=String(config.baseUrl??'').replace(/\/$/,'');
    const manageUrl=`${base}/book/manage?ref=${encodeURIComponent(row.reference)}&token=${encodeURIComponent(token)}`;
    const items=advance>0?`Registration fee and advance for ${row.space_name}`:`Registration fee for ${row.space_name}`;
    return {action:config.sandbox===false?'https://www.payhere.lk/pay/checkout':'https://sandbox.payhere.lk/pay/checkout',fields:{merchant_id:merchantId,return_url:manageUrl,cancel_url:manageUrl,notify_url:`${base}/api/public/payments/payhere/notify`,first_name:row.customer_name.split(/\s+/)[0]||row.customer_name,last_name:row.customer_name.split(/\s+/).slice(1).join(' ')||'-',email:row.email,phone:row.phone||'0000000000',address:'Not supplied',city:'Colombo',country:'Sri Lanka',order_id:orderId,items,currency,amount,custom_1:row.reference,hash:md5Upper(`${merchantId}${orderId}${amount}${currency}${md5Upper(merchantSecret)}`)},attemptId:Number(attempt.lastInsertRowid)};
  });
}

/** Release every active hold this request owns. */
function releaseHolds(db, requestId, now) {
  db.prepare(`UPDATE occupancy SET status='RELEASED',released_at=? WHERE id IN
    (SELECT occupancy_id FROM booking_hold_claim WHERE booking_request_id=? AND status='ACTIVE') AND status='ACTIVE'`).run(now, requestId);
  db.prepare("UPDATE booking_hold_claim SET status='RELEASED',released_at=? WHERE booking_request_id=? AND status='ACTIVE'").run(now, requestId);
}

const FEE_MODES = ['DISABLED', 'FIXED', 'PERCENTAGE'];

/**
 * Manual reconciliation for money that arrived but could not be converted
 * (for example a payment completed after its hold expired). The provider
 * evidence is kept; the administrator decides the outcome and it is audited.
 * No refund is ever claimed to have happened at the provider — that stays a
 * manual PayHere action, recorded here once done.
 */
export function resolvePaymentException(db, { actor, requestId, outcome, note, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  const allowed = ['REFUND_RECORDED', 'PAYMENT_KEPT'];
  const next = String(outcome ?? '').trim().toUpperCase();
  if (!allowed.includes(next)) throw validationError('Choose how the exception was resolved.', { outcome: 'Choose REFUND_RECORDED or PAYMENT_KEPT.' });
  const reason = requiredString(note, { field: 'note', max: 1000 });
  return withWriteTransaction(db, () => {
    const row = db.prepare(`${SELECT} WHERE br.id=?`).get(Number(requestId));
    if (!row) throw notFound('Booking request not found.');
    if (row.payment_status !== PAYMENT_STATUS.REVIEW_REQUIRED) throw conflict('This request has no payment exception to resolve.');
    if (next === 'REFUND_RECORDED') {
      releaseHolds(db, row.id, now);
      db.prepare('UPDATE booking_request SET status=?,payment_status=?,cancelled_at=?,cancellation_reason=?,updated_at=? WHERE id=?')
        .run(BOOKING_REQUEST_STATUS.CANCELLED, PAYMENT_STATUS.REFUNDED, now, reason, now, row.id);
    } else {
      db.prepare('UPDATE booking_request SET status=?,payment_status=?,updated_at=? WHERE id=?')
        .run(BOOKING_REQUEST_STATUS.CONFIRMED, PAYMENT_STATUS.PAID, now, row.id);
    }
    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label ?? actor.email ?? 'staff',
      action: 'booking_request.payment_exception_resolved',
      entityType: 'booking_request',
      entityId: row.id,
      summary: `${row.reference}: ${next}`,
      details: { outcome: next, note: reason },
    });
    return hydrate(db, db.prepare(`${SELECT} WHERE br.id=?`).get(row.id), { includePrivate: true });
  });
}

function secureEqual(a,b){const x=Buffer.from(String(a??''));const y=Buffer.from(String(b??''));return x.length===y.length&&timingSafeEqual(x,y);}

export function processPayHereNotification(db,payload={},config={},now=Date.now()) {
  const merchantId=String(payload.merchant_id??''); const orderId=String(payload.order_id??'');
  const statusCode=String(payload.status_code??''); const amount=String(payload.payhere_amount??''); const currency=String(payload.payhere_currency??'');
  const expected=md5Upper(`${merchantId}${orderId}${amount}${currency}${statusCode}${md5Upper(config.merchantSecret??'')}`);
  const signatureValid=Boolean(config.merchantSecret)&&merchantId===String(config.merchantId??'')&&secureEqual(expected,String(payload.md5sig??'').toUpperCase());
  const fingerprint=sha256([orderId,payload.payment_id,statusCode,amount,currency,payload.md5sig].join('|'));
  const result = withWriteTransaction(db,()=>{
    const duplicate=db.prepare('SELECT id FROM payment_event WHERE event_fingerprint=?').get(fingerprint);
    if(duplicate) return {accepted:true,idempotent:true};
    const attempt=db.prepare('SELECT * FROM payment_attempt WHERE order_id=?').get(orderId);
    const sanitized=JSON.stringify({merchant_id:merchantId,order_id:orderId,payment_id:String(payload.payment_id??''),payhere_amount:amount,payhere_currency:currency,status_code:statusCode,method:String(payload.method??''),status_message:String(payload.status_message??'').slice(0,300)});
    db.prepare('INSERT INTO payment_event (attempt_id,event_fingerprint,signature_valid,provider_payment_id,provider_status_code,sanitized_payload,received_at) VALUES (?,?,?,?,?,?,?)').run(attempt?.id??null,fingerprint,signatureValid?1:0,String(payload.payment_id??'')||null,statusCode,sanitized,now);
    if(!attempt||!signatureValid) return {accepted:false,idempotent:false};
    const expectedAmount=(Number(attempt.amount_cents)/100).toFixed(2);
    const exact=amount===expectedAmount&&currency===attempt.currency;
    const row=db.prepare(`SELECT br.*,po.booking_fee_cents,po.advance_paid_cents,po.remaining_balance_cents FROM booking_request br JOIN payment_obligation po ON po.booking_request_id=br.id WHERE br.id=?`).get(attempt.booking_request_id);
    if(statusCode==='2'&&exact){
      const claims=db.prepare("SELECT COUNT(*) AS c FROM booking_hold_claim h JOIN occupancy o ON o.id=h.occupancy_id WHERE h.booking_request_id=? AND h.status='ACTIVE' AND o.status='ACTIVE' AND h.expires_at>?").get(row.id,now);
      if(row.status===BOOKING_REQUEST_STATUS.CONFIRMED){
        if(attempt.status==='SUCCEEDED') return {accepted:true,idempotent:true};
        db.prepare("UPDATE payment_attempt SET status='REVIEW_REQUIRED',provider_payment_id=?,provider_method=?,provider_status_code=?,provider_message=?,updated_at=? WHERE id=?").run(payload.payment_id||null,payload.method||null,statusCode,'A second verified payment arrived after the booking was already confirmed.',now,attempt.id);
        db.prepare('UPDATE booking_request SET payment_status=?,updated_at=? WHERE id=?').run(PAYMENT_STATUS.REVIEW_REQUIRED,now,row.id);
        return {accepted:true,reviewRequired:true};
      }
      if(row.status!==BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT||Number(claims.c)!==Number(row.unit_count)){
        db.prepare(`UPDATE occupancy SET status='RELEASED',released_at=? WHERE id IN (SELECT occupancy_id FROM booking_hold_claim WHERE booking_request_id=? AND status='ACTIVE') AND status='ACTIVE'`).run(now,row.id);
        db.prepare("UPDATE booking_hold_claim SET status='RELEASED',released_at=? WHERE booking_request_id=? AND status='ACTIVE'").run(now,row.id);
        db.prepare("UPDATE payment_attempt SET status='REVIEW_REQUIRED',provider_payment_id=?,provider_method=?,provider_status_code=?,provider_message=?,updated_at=? WHERE id=?").run(payload.payment_id||null,payload.method||null,statusCode,'Payment verified after hold was unavailable.',now,attempt.id);
        db.prepare('UPDATE booking_request SET status=?,payment_status=?,updated_at=? WHERE id=?').run(BOOKING_REQUEST_STATUS.PAYMENT_REVIEW_REQUIRED,PAYMENT_STATUS.REVIEW_REQUIRED,now,row.id);
        return {accepted:true,reviewRequired:true};
      }
      const advance=Number(attempt.advance_cents??0);
      if(advance>Number(row.remaining_balance_cents)){
        db.prepare("UPDATE payment_attempt SET status='REVIEW_REQUIRED',provider_payment_id=?,provider_method=?,provider_status_code=?,provider_message=?,updated_at=? WHERE id=?").run(payload.payment_id||null,payload.method||null,statusCode,'Verified advance exceeded the remaining venue balance.',now,attempt.id);
        db.prepare('UPDATE booking_request SET status=?,payment_status=?,updated_at=? WHERE id=?').run(BOOKING_REQUEST_STATUS.PAYMENT_REVIEW_REQUIRED,PAYMENT_STATUS.REVIEW_REQUIRED,now,row.id);
        return {accepted:true,reviewRequired:true};
      }
      if(advance>0) db.prepare('UPDATE payment_obligation SET advance_paid_cents=advance_paid_cents+?,remaining_balance_cents=remaining_balance_cents-? WHERE booking_request_id=?').run(advance,advance,row.id);
      confirmFromHold(db,row,now);
      db.prepare("UPDATE payment_attempt SET status='SUCCEEDED',provider_payment_id=?,provider_method=?,provider_status_code=?,provider_message=?,updated_at=? WHERE id=?").run(payload.payment_id||null,payload.method||null,statusCode,payload.status_message||null,now,attempt.id);
      recordAudit(db,{actorLabel:'PayHere verified callback',action:'booking_request.payment_verified',entityType:'booking_request',entityId:row.id,summary:`Verified payment for ${row.reference}`,details:{amountCents:Number(attempt.amount_cents),registrationFeeCents:Number(row.booking_fee_cents),advanceCents:advance}});
      return {accepted:true,confirmed:true,requestReference:row.reference};
    }
    if(statusCode==='2'&&!exact){
      db.prepare("UPDATE payment_attempt SET status='REVIEW_REQUIRED',provider_payment_id=?,provider_method=?,provider_status_code=?,provider_message=?,updated_at=? WHERE id=?").run(payload.payment_id||null,payload.method||null,statusCode,'Verified callback amount or currency did not match the immutable obligation.',now,attempt.id);
      db.prepare('UPDATE booking_request SET status=?,payment_status=?,updated_at=? WHERE id=?').run(BOOKING_REQUEST_STATUS.PAYMENT_REVIEW_REQUIRED,PAYMENT_STATUS.REVIEW_REQUIRED,now,row.id);
      return {accepted:true,reviewRequired:true};
    }
    if(statusCode==='-3'){
      db.prepare("UPDATE payment_attempt SET status='REVIEW_REQUIRED',provider_payment_id=?,provider_method=?,provider_status_code=?,provider_message=?,updated_at=? WHERE id=?").run(payload.payment_id||null,payload.method||null,statusCode,payload.status_message||'Chargeback',now,attempt.id);
      db.prepare('UPDATE booking_request SET status=?,payment_status=?,updated_at=? WHERE id=?').run(BOOKING_REQUEST_STATUS.PAYMENT_REVIEW_REQUIRED,PAYMENT_STATUS.REVIEW_REQUIRED,now,row.id);
      return {accepted:true,reviewRequired:true};
    }
    const next=statusCode==='0'?'PENDING':statusCode==='-1'?'CANCELLED':'FAILED';
    db.prepare('UPDATE payment_attempt SET status=?,provider_payment_id=?,provider_method=?,provider_status_code=?,provider_message=?,updated_at=? WHERE id=?').run(next,payload.payment_id||null,payload.method||null,statusCode,payload.status_message||null,now,attempt.id);
    db.prepare('UPDATE booking_request SET payment_status=?,updated_at=? WHERE id=?').run(statusCode==='0'?PAYMENT_STATUS.PENDING:PAYMENT_STATUS.FAILED,now,row.id);
    return {accepted:true,confirmed:false};
  });
  if (result?.confirmed && result.requestReference) {
    afterBookingRequestConfirmed(db, { reference: result.requestReference, now });
  }
  return result;
}
