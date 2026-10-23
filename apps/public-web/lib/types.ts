export type PublicImage = {
  id: string | number;
  url: string | null;
  altText: string | null;
  isCover: boolean;
};

export type PublicRate = {
  unit: string;
  unitLabel: string;
  amountCents: number;
  amountLabel: string;
  isDefault: boolean;
};

export type PublicSpace = {
  id: string | number;
  code: string;
  name: string;
  category: string;
  categoryLabel: string;
  shortDescription: string | null;
  description: string | null;
  location: string | null;
  floor: string | null;
  capacity: number | null;
  unitCount: number;
  pricingUnit: string | null;
  openTime: string;
  closeTime: string;
  minDurationMinutes: number;
  maxDurationMinutes: number | null;
  bufferMinutes: number;
  rates: Record<string, number>;
  rateList: PublicRate[];
  rateSummary: string;
  amenities: string[];
  attributes: Record<string, string | number | boolean>;
  images: PublicImage[];
  isPublished: boolean;
};

export type SpaceListResponse = {
  items: PublicSpace[];
  total: number;
  publishedTotal: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export type Availability = {
  spaceCode: string;
  spaceName: string;
  startAt: number;
  endAt: number;
  isPooled: boolean;
  totalUnits: number;
  freeUnits: number;
  requestedUnits: number;
  isAvailable: boolean;
  label: string;
  checkedAt: number;
};

export type Reservation = {
  reference: string;
  status: string;
  spaceCode: string;
  spaceName: string;
  startAt: number;
  endAt: number;
  unitCount: number;
  attendees: number | null;
  billingUnit: string;
  billingQuantity: number;
  rateCents: number;
  totalCents: number;
  currency: string;
};

export type BookingRequest = {
  reference: string; status: string; paymentStatus: string;
  spaceCode: string; spaceName: string; startAt: number; endAt: number;
  unitCount: number; attendees: number | null; purpose: string | null;
  billingUnit: string; billingQuantity: number; rateCents: number;
  venueTotalCents: number; currency: string; holdExpiresAt: number | null;
  rejectionReason: string | null; reservationReference: string | null;
  payment: null | {
    bookingFeeCents: number;
    advancePaidCents: number;
    venueTotalCents: number;
    remainingBalanceCents: number;
    currency: string;
    latestAttempt: null | {
      orderId: string;
      amountCents: number;
      advanceCents: number;
      status: string;
      paymentId: string | null;
      method: string | null;
      statusCode: string | null;
      updatedAt: number;
    };
  };
};

export type PublicCalendarSlot = {
  startAt: number;
  endAt: number;
  freeUnits: number;
  totalUnits: number;
  isFree: boolean;
};

export type PublicCalendarSpaceDay = {
  spaceCode: string;
  openTime: string;
  closeTime: string;
  totalUnits: number;
  slots: PublicCalendarSlot[];
};

export type PublicCalendarDay = {
  dateKey: string;
  spaces: PublicCalendarSpaceDay[];
};

export type PublicCalendarSpace = {
  code: string;
  name: string;
  category: string;
  openTime: string;
  closeTime: string;
  totalUnits: number;
};

/** GET /api/public/availability/calendar */
export type PublicCalendarResponse = {
  from: string;
  to: string;
  timezone: string;
  spaces: PublicCalendarSpace[];
  days: PublicCalendarDay[];
};

export type ApiError = {
  ok?: false;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
};
