import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTestActor, createTestDb } from '../helpers/testDb.js';
import { parseBookingWindow } from '../../src/server/domain/validation.js';
import {
  approveBookingRequest, createBookingRequest, createPayHereCheckout,
  createSelfServiceBooking, expireBookingHolds, getBookingRequest, processPayHereNotification,
  rejectBookingRequest,
} from '../../src/server/services/bookingRequestService.js';
import { createPublicBooking } from '../../src/server/services/publicBookingService.js';

function md5(value){return createHash('md5').update(value).digest('hex').toUpperCase();}
function seedSpace(db){
  const now=Date.now();
  const inserted=db.prepare(`INSERT INTO space
    (code,name,category,short_description,capacity,status,currency,pricing_unit,min_duration_minutes,max_duration_minutes,buffer_minutes,open_time,close_time,amenities,attributes,created_at,updated_at,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('FLOW-01','Workflow Room','MEETING_ROOM','A test venue',20,'PUBLISHED','LKR','HOUR',60,480,0,'08:00','18:00','[]','{}',now,now,now);
  const id=Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO space_rate (space_id,unit,amount_cents,is_default) VALUES (?,?,?,1)').run(id,'HOUR',250000);
  db.prepare('INSERT INTO resource_unit (space_id,code,label,kind,is_active,created_at) VALUES (?,?,?,?,1,?)').run(id,'FLOW-ROOM','Workflow Room','EXCLUSIVE',now);
  return id;
}
function input(spaceId,key='flow:one'){
  const window=parseBookingWindow({date:'2030-08-14',start_time:'09:00',end_time:'11:00'});
  return {spaceId,startAt:window.startAt,endAt:window.endAt,unitCount:1,attendees:8,purpose:'Design workshop',idempotencyKey:key,customer:{fullName:'Asha Perera',email:'asha@example.com',phone:'+94 77 123 4567',organization:'Studio One'}};
}

test('request is idempotent, consumes no inventory, and rejection remains terminal',()=>{
  const db=createTestDb();const actor=createTestActor(db);const spaceId=seedSpace(db);
  const first=createBookingRequest(db,input(spaceId));const retry=createBookingRequest(db,input(spaceId));
  assert.equal(first.request.status,'REQUESTED');assert.equal(retry.idempotent,true);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").get().c,0);
  const rejected=rejectBookingRequest(db,{actor,requestId:db.prepare('SELECT id FROM booking_request').get().id,reason:'Schedule unsuitable'});
  assert.equal(rejected.status,'REJECTED');
  assert.throws(()=>approveBookingRequest(db,{actor,requestId:db.prepare('SELECT id FROM booking_request').get().id}),e=>e?.status===409);
  db.close();
});

test('self-service checkout confirms immediately and rejects an overlapping checkout',()=>{
  const db=createTestDb();const spaceId=seedSpace(db);
  const first=createSelfServiceBooking(db,input(spaceId,'direct:first'));
  assert.equal(first.request.status,'CONFIRMED');
  assert.match(first.request.reservationReference,/^NG-/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservation WHERE status='CONFIRMED'").get().c,1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").get().c,1);

  const retry=createSelfServiceBooking(db,input(spaceId,'direct:first'));
  assert.equal(retry.idempotent,true);
  assert.equal(retry.request.reservationReference,first.request.reservationReference);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservation WHERE status='CONFIRMED'").get().c,1);

  assert.throws(
    ()=>createSelfServiceBooking(db,{...input(spaceId,'direct:second'),customer:{fullName:'Second Guest',email:'second@example.com'}}),
    (error)=>error?.code==='DOUBLE_BOOKING_CONFLICT',
  );
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reservation WHERE status='CONFIRMED'").get().c,1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").get().c,1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM booking_request WHERE status='REJECTED'").get().c,1);
  db.close();
});

test('self-service checkout skips staff approval and holds inventory when a fee is enabled',()=>{
  const db=createTestDb();const spaceId=seedSpace(db);
  db.prepare("UPDATE booking_fee_policy SET mode='FIXED',fixed_cents=100000,payment_window_minutes=15 WHERE id=1").run();
  const checkout=createSelfServiceBooking(db,input(spaceId,'direct:fee'));
  assert.equal(checkout.request.status,'APPROVED_AWAITING_PAYMENT');
  assert.equal(checkout.request.payment.bookingFeeCents,100000);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").get().c,1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM booking_request WHERE status='REQUESTED'").get().c,0);
  assert.throws(
    ()=>createSelfServiceBooking(db,{...input(spaceId,'direct:fee-conflict'),customer:{fullName:'Second Guest',email:'second@example.com'}}),
    (error)=>error?.code==='DOUBLE_BOOKING_CONFLICT',
  );
  db.close();
});

test('approval creates a guarded hold and expiry releases it',()=>{
  const db=createTestDb();const actor=createTestActor(db);const spaceId=seedSpace(db);
  db.prepare("UPDATE booking_fee_policy SET mode='FIXED',fixed_cents=100000,payment_window_minutes=5 WHERE id=1").run();
  const created=createBookingRequest(db,input(spaceId));const id=db.prepare('SELECT id FROM booking_request').get().id;
  const approved=approveBookingRequest(db,{actor,requestId:id,now:Date.UTC(2029,0,1)});
  assert.equal(approved.status,'APPROVED_AWAITING_PAYMENT');assert.equal(approved.payment.bookingFeeCents,100000);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").get().c,1);
  assert.throws(()=>createPublicBooking(db,{...input(spaceId,'legacy:competitor'),customer:{fullName:'Other Guest',email:'other@example.com'}}),e=>e?.code==='DOUBLE_BOOKING_CONFLICT');
  assert.equal(expireBookingHolds(db,Date.UTC(2029,0,1)+6*60_000),1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").get().c,0);
  db.close();
});

test('only a valid exact PayHere callback confirms once',()=>{
  const db=createTestDb();const actor=createTestActor(db);const spaceId=seedSpace(db);
  db.prepare("UPDATE booking_fee_policy SET mode='FIXED',fixed_cents=100000,payment_window_minutes=120 WHERE id=1").run();
  const created=createBookingRequest(db,input(spaceId));const id=db.prepare('SELECT id FROM booking_request').get().id;
  approveBookingRequest(db,{actor,requestId:id,now:Date.UTC(2029,0,1)});
  const cfg={merchantId:'1210000',merchantSecret:'sandbox-secret',sandbox:true,baseUrl:'https://example.test'};
  const checkout=createPayHereCheckout(db,{reference:created.request.reference,token:created.manageToken,config:cfg,now:Date.UTC(2029,0,1)+1000});
  const f=checkout.fields;const bad=processPayHereNotification(db,{merchant_id:f.merchant_id,order_id:f.order_id,payment_id:'P-1',payhere_amount:f.amount,payhere_currency:f.currency,status_code:'2',md5sig:'BAD'},cfg,Date.UTC(2029,0,1)+2000);
  assert.equal(bad.accepted,false);assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c,0);
  const sig=md5(`${f.merchant_id}${f.order_id}${f.amount}${f.currency}2${md5(cfg.merchantSecret)}`);
  const payload={merchant_id:f.merchant_id,order_id:f.order_id,payment_id:'P-1',payhere_amount:f.amount,payhere_currency:f.currency,status_code:'2',md5sig:sig,method:'VISA',status_message:'Success'};
  const paid=processPayHereNotification(db,payload,cfg,Date.UTC(2029,0,1)+3000);
  assert.equal(paid.confirmed,true);assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c,1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM occupancy WHERE status='ACTIVE'").get().c,1);
  const duplicate=processPayHereNotification(db,payload,cfg,Date.UTC(2029,0,1)+4000);
  assert.equal(duplicate.idempotent,true);assert.equal(db.prepare('SELECT COUNT(*) c FROM reservation').get().c,1);
  const visible=getBookingRequest(db,{reference:created.request.reference,token:created.manageToken});
  assert.equal(visible.status,'CONFIRMED');assert.equal(visible.paymentStatus,'PAID');
  db.close();
});
