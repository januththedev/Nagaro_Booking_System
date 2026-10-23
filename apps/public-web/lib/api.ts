import type {
  Availability,
  BookingRequest,
  PublicCalendarResponse,
  PublicSpace,
  Reservation,
  SpaceListResponse,
} from "./types";

export const serverBase = () => {
  // Order matters. The deployment-specific VERCEL_URL sits behind Vercel's
  // Deployment Protection and cannot be fetched from inside a function (the
  // request is answered with a login page), while the canonical production
  // domain is publicly reachable — so prefer the canonical origin and fall
  // back to the deployment URL only when nothing else is configured.
  const vercelProduction = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "";
  const vercelOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
  const raw =
    process.env.API_ORIGIN ||
    process.env.NEXT_PUBLIC_API_BASE ||
    process.env.NAGARO_BASE_URL ||
    vercelProduction ||
    vercelOrigin ||
    "http://127.0.0.1:4173";
  return /^https?:\/\//.test(raw) ? raw.replace(/\/$/, "") : "http://127.0.0.1:4173";
};

export const clientApiPath = (path: string) => {
  const base = process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "";
  return `${base}${path}`;
};

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${serverBase()}${path}`, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `Request failed with status ${response.status}.`);
  }
  return body as T;
}

export async function getSpaces(): Promise<{ spaces: PublicSpace[]; available: boolean }> {
  try {
    const body = await apiFetch<SpaceListResponse>("/api/public/spaces?page=1&pageSize=100&sort=name");
    return { spaces: Array.isArray(body.items) ? body.items : [], available: true };
  } catch {
    return { spaces: [], available: false };
  }
}

export async function getSpace(code: string): Promise<PublicSpace | null> {
  try {
    return await apiFetch<PublicSpace>(`/api/public/spaces/${encodeURIComponent(code)}`);
  } catch {
    return null;
  }
}

export async function getBooking(reference: string, token: string): Promise<Reservation | null> {
  if (!reference || !token) return null;
  try {
    const body = await apiFetch<{ ok: true; data: { reservation: Reservation } }>(
      `/api/public/bookings/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return body.data.reservation;
  } catch {
    return null;
  }
}

export async function getAvailabilityCalendar(
  from: string,
  to: string,
): Promise<PublicCalendarResponse | null> {
  try {
    const query = new URLSearchParams({ from, to });
    // This request runs during Next server rendering. Cache it briefly so a
    // busy page does not proxy every visitor through the same server IP and
    // exhaust the API's anonymous read limit. The hydrated calendar continues
    // polling the same-origin endpoint directly for live updates.
    const response = await fetch(
      `${serverBase()}/api/public/availability/calendar?${query.toString()}`,
      {
        headers: { Accept: "application/json" },
        next: { revalidate: 30 },
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !Array.isArray(body.days)) return null;
    return body as PublicCalendarResponse;
  } catch {
    return null;
  }
}

export async function getBookingRequest(reference:string,token:string):Promise<BookingRequest|null>{
  if(!reference||!token)return null;
  try{const body=await apiFetch<{ok:true;request:BookingRequest}>(`/api/public/booking-requests/${encodeURIComponent(reference)}`,{headers:{Authorization:`Bearer ${token}`}});return body.request;}catch{return null;}
}

export type { Availability, PublicSpace, Reservation };
