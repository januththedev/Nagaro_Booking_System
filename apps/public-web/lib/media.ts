import type { PublicSpace } from "./types";

export const OFFICIAL_MEDIA = {
  hero: "/assets/trace-media/research/trace-spaces-hero.webp",
  longExterior: "/assets/trace-media/research/expert-city-industry-visits.webp",
  coworking: "/assets/trace-media/research/expert-city-coworking.webp",
  privateOffices: "/assets/trace-media/research/expert-city-private-offices.webp",
  creator: "/assets/trace-media/research/creator-space.jpg",
  bay: "/assets/trace-media/research/bay-07.jpg",
  outdoor: "/assets/trace-media/research/outdoor-space.webp",
  studio: "/assets/trace-media/research/idea-studio.webp",
  community: "/assets/trace-media/research/third-place-lobby.jpg",
} as const;

const categoryMedia: Record<string, string> = {
  COWORKING: OFFICIAL_MEDIA.coworking,
  MEETING_ROOM: OFFICIAL_MEDIA.studio,
  EVENT_SPACE: OFFICIAL_MEDIA.bay,
  AUDITORIUM: OFFICIAL_MEDIA.bay,
  OFFICE: OFFICIAL_MEDIA.privateOffices,
};

export function coverFor(space: PublicSpace): { src: string; alt: string; isVenueImage: boolean } {
  const image = space.images.find((item) => item.isCover && item.url) ?? space.images.find((item) => item.url);
  if (image?.url) {
    return {
      src: image.url,
      alt: image.altText || `${space.name} at TRACE Expert City`,
      isVenueImage: true,
    };
  }
  return {
    src: categoryMedia[space.category] || OFFICIAL_MEDIA.longExterior,
    alt: `The TRACE Expert City campus, home to ${space.name}`,
    isVenueImage: false,
  };
}

export const campusGallery = [
  { src: OFFICIAL_MEDIA.creator, alt: "Creator Space arranged for an intimate presentation", title: "Creator Space", note: "Workshops, training and focused sessions" },
  { src: OFFICIAL_MEDIA.outdoor, alt: "TRACE Outdoor Space and water feature", title: "Outdoor Space", note: "Open-air gatherings and community events" },
  { src: OFFICIAL_MEDIA.studio, alt: "TRACE Idea Studio workshop setup", title: "Idea Studio", note: "Small teams, podcasts and micro-events" },
  { src: OFFICIAL_MEDIA.bay, alt: "A large brick event hall at TRACE staged for a conference", title: "Bay 07", note: "Industrial scale, transformed by production" },
  { src: OFFICIAL_MEDIA.community, alt: "A networking gathering in the Third Place Lobby", title: "Third Place", note: "Conversation, community and connection" },
];
