import { AvailabilityCalendar } from "../../components/AvailabilityCalendar";
import { getAvailabilityCalendar } from "../../lib/api";
import { mondayOf, weekDateKeys } from "../../lib/availability";
import { isoDateInColombo } from "../../lib/format";

export const metadata = {
  title: "Availability · TRACE Spaces",
  description: "Live hourly availability for TRACE meeting rooms, auditorium and co-working desks in Colombo.",
};

/**
 * Public weekly availability calendar.
 *
 * The initial date is resolved on the server in Sri Lanka Standard Time so
 * the first paint and the client's "today" agree; the component then owns
 * week navigation and fetches the range from the public API.
 */
export default async function AvailabilityPage() {
  const initialDateKey = isoDateInColombo(0);
  const weekDates = weekDateKeys(mondayOf(initialDateKey));
  const initialData = await getAvailabilityCalendar(weekDates[0], weekDates[6]);
  return <AvailabilityCalendar initialDateKey={initialDateKey} initialData={initialData} />;
}
