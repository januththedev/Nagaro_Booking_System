"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Availability, CheckoutQuote, PublicSpace } from "../lib/types";
import { formatMoney, isoDateInColombo } from "../lib/format";
import { clientApiPath } from "../lib/api";
import { format } from "../lib/i18n";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { useT } from "./I18nProvider";

type AssistantDraft = { spaceCode?: string; date?: string; startTime?: string; endTime?: string;
  unitCount?: number; attendees?: number; purpose?: string; customerName?: string;
  email?: string; phone?: string; organization?: string };

function prefillClock(value:string|null){
  const match=/^(\d{1,2}):(\d{2})$/.exec((value??"").trim());
  if(!match)return "";
  const hours=Number(match[1]);const minutes=Number(match[2]);
  if(hours>23||minutes>59)return "";
  return `${hours<10?"0":""}${hours}:${minutes<10?"0":""}${minutes}`;
}

export function UnifiedRequestForm({space,formToken}:{space:PublicSpace;formToken:string}){
  const t=useT();
  const availabilityVersion=useRef(0);
  const draftVersion=useRef(0);
  const draftRequests=useRef(new Map<string, Promise<{ok:boolean;draft?:AssistantDraft}>>());
  const router=useRouter(); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [draftLoaded,setDraftLoaded]=useState(false);
  const [values,setValues]=useState({date:"",startTime:space.openTime||"09:00",endTime:space.closeTime||"17:00",unitCount:"1",attendees:"",purpose:"",fullName:"",email:"",phone:"",organization:""});
  const [checkoutQuote,setCheckoutQuote]=useState<CheckoutQuote|null>(null);
  const [windowProblem,setWindowProblem]=useState("");
  const [liveAvailability,setLiveAvailability]=useState<{state:"idle"|"checking"|"ok"|"busy"|"invalid"|"error-window"|"error";freeUnits?:number;totalUnits?:number}>({state:"idle"});
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const rawDate=(params.get("date")??"").trim();
    const date=/^\d{4}-\d{2}-\d{2}$/.test(rawDate)?rawDate:"";
    const startTime=prefillClock(params.get("start")??params.get("start_time"));
    const endTime=prefillClock(params.get("end")??params.get("end_time"));
    const rawUnits=(params.get("unit_count")??params.get("desks")??"").trim();
    const unitCount=/^\d{1,3}$/.test(rawUnits)&&Number(rawUnits)>=1&&Number(rawUnits)<=500?String(Number(rawUnits)):"";
    if(!date&&!startTime&&!endTime&&!unitCount)return;
    setValues(v=>({...v,...(date?{date}:{}),...(startTime?{startTime}:{}),...(endTime?{endTime}:{}),...(unitCount?{unitCount}:{})}));
  },[]);
  useEffect(() => {
    let active = true;
    async function loadDraft(token: string) {
      const version = ++draftVersion.current;
      try {
        let pending = draftRequests.current.get(token);
        if (!pending) {
          pending = fetch(clientApiPath('/api/public/assistant/drafts/resolve'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
          }).then(async response => ({ ok: response.ok, ...(await response.json()) }));
          draftRequests.current.set(token, pending);
        }
        const body = await pending;
        if (!active || version !== draftVersion.current) return;
        const d = body?.draft;
        if (!body.ok || !d || (d.spaceCode && d.spaceCode !== space.code)) throw new Error(t.request.draftError);
        availabilityVersion.current += 1;
        setCheckoutQuote(null);
        setLiveAvailability({ state: 'idle' });
        setValues(v => ({ ...v, date: d.date || v.date, startTime: d.startTime || v.startTime,
          endTime: d.endTime || v.endTime, unitCount: String(d.unitCount || v.unitCount),
          attendees: String(d.attendees || v.attendees), purpose: d.purpose || v.purpose,
          fullName: d.customerName || v.fullName, email: d.email || v.email,
          phone: d.phone || v.phone, organization: d.organization || v.organization }));
        setDraftLoaded(true);
        setError('');
        history.replaceState(null, '', location.pathname + location.search);
      } catch {
        if (active && version === draftVersion.current) setError(t.request.draftError);
      }
    }
    const incoming = (event: Event) => {
      const token = (event as CustomEvent<{ token?: string }>).detail?.token;
      if (typeof token === 'string') void loadDraft(token);
    };
    window.addEventListener('trace:booking-draft', incoming);
    const token = new URLSearchParams(window.location.hash.slice(1)).get('draft');
    if (token) void loadDraft(token);
    return () => { active = false; window.removeEventListener('trace:booking-draft', incoming); };
  }, [space.code]);

  const set=(key:keyof typeof values)=>(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>{setValues(v=>({...v,[key]:e.target.value}));if(["date","startTime","endTime","unitCount"].includes(key)){availabilityVersion.current+=1;setCheckoutQuote(null);setLiveAvailability({state:"idle"});}};
  const startIso=values.date?`${values.date}T${values.startTime}:00+05:30`:"";
  const endIso=values.date?`${values.date}T${values.endTime}:00+05:30`:"";
  const hasValidWindow=Boolean(startIso&&endIso&&Date.parse(endIso)>Date.parse(startIso));
  const liveAvailabilityMessage=liveAvailability.state==="idle"?t.venue.availabilityIdle
    :liveAvailability.state==="checking"?t.venue.availabilityChecking
    :liveAvailability.state==="ok"&&liveAvailability.freeUnits!==undefined&&liveAvailability.totalUnits!==undefined
      ?format(t.venue.availabilityOkPooled,{free:liveAvailability.freeUnits,total:liveAvailability.totalUnits})
      :liveAvailability.state==="ok"?t.venue.availabilityOk
      :liveAvailability.state==="busy"?t.venue.availabilityBusy
      :liveAvailability.state==="invalid"?t.catalogue.windowErrorOrder
      :liveAvailability.state==="error-window"?(windowProblem||t.venue.availabilityErrorWindow)
      :t.venue.availabilityError;
  const availabilityHasError=["busy","invalid","error-window","error"].includes(liveAvailability.state);

  async function refreshAvailability(signal:AbortSignal,foreground=false){
    const version=++availabilityVersion.current;
    if(!values.date){setLiveAvailability({state:"idle"});return;}
    if(!hasValidWindow){setLiveAvailability({state:"invalid"});return;}
    if(foreground){setCheckoutQuote(null);setWindowProblem("");setLiveAvailability({state:"checking"});}
    try{
      const qs=new URLSearchParams({space:space.code,start:startIso,end:endIso,desks:space.category==="COWORKING"?String(Math.max(1,Number(values.unitCount)||1)):"1"});
      const res=await fetch(clientApiPath(`/api/public/availability?${qs.toString()}`),{cache:"no-store",signal,headers:{Accept:"application/json"}});
      const body=(await res.json().catch(()=>null)) as (Availability&{error?:{message?:string}})|null;
      if(signal.aborted||version!==availabilityVersion.current)return;
      if(!res.ok||!body){setCheckoutQuote(null);setWindowProblem(body?.error?.message||t.venue.availabilityErrorWindow);setLiveAvailability({state:"error-window"});return;}
      setCheckoutQuote(body.quote??null);
      setLiveAvailability(body.isAvailable?{
        state:"ok",
        ...(body.isPooled?{freeUnits:body.freeUnits,totalUnits:body.totalUnits}:{}),
      }:{state:"busy"});
    }catch(caught){
      if(!signal.aborted&&version===availabilityVersion.current){setCheckoutQuote(null);setLiveAvailability({state:"error"});}
    }
  }

  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(()=>void refreshAvailability(controller.signal,true),450);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[values.date,values.startTime,values.endTime,values.unitCount]);

  useLiveRefresh(
    signal=>refreshAvailability(signal,false),
    {enabled:hasValidWindow,intervalMs:8_000},
  );

  async function submit(e:React.FormEvent){e.preventDefault();if(busy||!checkoutQuote||liveAvailability.state!=="ok")return;setBusy(true);setError("");try{const res=await fetch(clientApiPath('/api/public/bookings'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spaceCode:space.code,...values,formToken,expectedQuote:checkoutQuote})});const body=await res.json();if(!res.ok)throw new Error(body?.error?.message||t.request.errorGeneric);if(!body?.data?.managePath)throw new Error(t.request.errorGeneric);router.push(body.data.managePath);}catch(e){setError(e instanceof Error?e.message:t.request.errorGeneric);setBusy(false);}}
  return <div className="grid lg:grid-cols-12 min-h-dvh pt-20">
    <aside className="lg:col-span-5 relative min-h-[45vh] lg:min-h-[calc(100dvh-5rem)] surface-dark overflow-hidden">
      {space.images[0]?.url?<img src={space.images[0].url} alt={space.images[0].altText||space.name} className="absolute inset-0 w-full h-full object-cover opacity-65"/>:null}<div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent"/>
      <div className="relative h-full p-6 sm:p-10 flex flex-col justify-end text-[var(--bone)]"><p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--chartreuse)]">{t.request.asideEyebrow}</p><h1 className="font-display text-5xl sm:text-7xl leading-[0.92] m-0">{space.name}</h1><p className="max-w-md text-sm text-white/75 mt-5">{t.request.asideIntro}</p></div>
    </aside>
    <section className="lg:col-span-7 px-4 sm:px-10 xl:px-20 py-12 lg:py-20 bg-[var(--bone)]">
      <div className="max-w-2xl"><p className="font-mono text-xs uppercase tracking-[0.16em] text-[var(--brick)]">{t.request.formEyebrow}</p><h2 className="font-display text-4xl sm:text-6xl leading-none">{t.request.formTitle}</h2>{draftLoaded?<div className="my-6 border-l-2 border-[var(--oxidized)] pl-4 text-sm">{t.request.aiDraftLoaded}</div>:null}
      <form method="post" action="/book" onSubmit={submit} className="booking-form mt-10 grid sm:grid-cols-2 gap-x-5 gap-y-6">
        <input type="hidden" name="form_token" value={formToken}/>
        <input type="hidden" name="space_code" value={space.code}/>
        <label className="sm:col-span-2">{t.request.dateLabel}<input name="date" type="date" min={isoDateInColombo(0)} required value={values.date} onChange={set('date')}/></label>
        <label>{t.request.startTimeLabel}<input name="start_time" type="time" required value={values.startTime} onChange={set('startTime')}/></label><label>{t.request.endTimeLabel}<input name="end_time" type="time" required value={values.endTime} onChange={set('endTime')}/></label>
        {space.category==='COWORKING'?<label>{t.request.desksLabel}<input name="unit_count" type="number" min="1" required value={values.unitCount} onChange={set('unitCount')}/></label>:null}<label>{t.request.peopleLabel}<input name="attendees" type="number" min="1" value={values.attendees} onChange={set('attendees')}/></label>
        <div aria-live="polite" className={`sm:col-span-2 border-l-2 px-4 py-3 text-sm ${liveAvailability.state==="ok"?"border-[var(--oxidized)] bg-[#e6f2ec] text-[var(--oxidized)]":availabilityHasError?"border-[var(--brick)] bg-[#faeae6] text-[var(--brick)]":"border-[var(--rule)] bg-[var(--concrete)]/45 text-[var(--graphite)]"}`}>
          <span className="font-mono text-[0.68rem] uppercase tracking-[0.14em] block mb-1">{t.status.liveUpdates}</span>
          {liveAvailabilityMessage}
        </div>
        <label className="sm:col-span-2">{t.request.purposeLabel}<textarea name="purpose" rows={4} value={values.purpose} onChange={set('purpose')} placeholder={t.request.purposePlaceholder}/></label>
        <div className="sm:col-span-2 border-t border-[var(--rule)] pt-7 mt-2"><h3 className="font-display text-3xl m-0">{t.request.detailsTitle}</h3></div>
        <label>{t.request.fullNameLabel}<input name="full_name" required maxLength={160} value={values.fullName} onChange={set('fullName')}/></label><label>{t.request.emailLabel}<input name="email" type="email" required maxLength={254} value={values.email} onChange={set('email')}/></label><label>{t.request.phoneLabel}<input name="phone" value={values.phone} onChange={set('phone')}/></label><label>{t.request.organizationLabel}<input name="organization" value={values.organization} onChange={set('organization')}/></label>
        {checkoutQuote ? <section className="sm:col-span-2 border border-[var(--rule)] p-5" aria-live="polite" aria-label={t.status.summaryTitle}>
          <h3 className="font-display text-2xl">{t.status.summaryTitle}</h3>
          <p>{values.date} · {values.startTime}–{values.endTime} SLST</p>
          <p>{checkoutQuote.billingQuantity} × {formatMoney(checkoutQuote.rateCents,checkoutQuote.currency)}{space.category==="COWORKING"?` × ${checkoutQuote.unitCount}`:""}</p>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <dt>{t.status.venueTotal}</dt><dd className="text-right font-semibold">{formatMoney(checkoutQuote.totalCents,checkoutQuote.currency)}</dd>
            <dt>{t.status.registrationFee}</dt><dd className="text-right">{formatMoney(checkoutQuote.bookingFeeCents,checkoutQuote.currency)}</dd>
            <dt>{t.status.balanceLabel}</dt><dd className="text-right">{formatMoney(checkoutQuote.remainingBalanceCents,checkoutQuote.currency)}</dd>
          </dl>
        </section> : null}
        <div className="soft-box sm:col-span-2 mt-4 p-5 sm:p-6 flex flex-col sm:flex-row gap-5 justify-between sm:items-center"><div><p className="font-mono text-xs uppercase tracking-wider m-0 text-[var(--ink)]">{t.request.noticeTitle}</p><p className="text-sm text-[var(--graphite)] normal-case tracking-normal font-sans m-0 mt-2">{t.request.noticeBody}</p></div><button disabled={busy||liveAvailability.state!=="ok"||!checkoutQuote} className="btn-primary shrink-0">{busy?t.request.submitting:liveAvailability.state==="busy"?t.venue.availabilityBusy:t.request.submit}</button></div>
        {error?<p role="alert" className="sm:col-span-2 text-[var(--brick)]">{error}</p>:null}
      </form></div>
    </section>
  </div>;
}
