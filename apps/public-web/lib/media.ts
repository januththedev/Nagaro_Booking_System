import type { PublicSpace } from "./types";

export const OFFICIAL_MEDIA = {
  hero: "/trace-media/research/trace-spaces-hero.webp",
  longExterior: "/trace-media/research/expert-city-industry-visits.webp",
  coworking: "/trace-media/research/expert-city-coworking.webp",
  privateOffices: "/trace-media/research/expert-city-private-offices.webp",
  creator: "/trace-media/research/creator-space.jpg",
  bay: "/trace-media/research/bay-07.jpg",
  outdoor: "/trace-media/research/outdoor-space.webp",
  studio: "/trace-media/research/idea-studio.webp",
  community: "/trace-media/research/third-place-lobby.jpg",
  eventProduction: "/trace-media/research/expert-city-spaces.jpg",
  startupHall: "/trace-media/research/expert-city-startups.webp",
} as const;

type EditorialImage = {
  src: string;
  alt: string;
};

const categoryMedia: Record<string, EditorialImage> = {
  COWORKING: {
    src: OFFICIAL_MEDIA.coworking,
    alt: "The active coworking hall inside TRACE Expert City",
  },
  MEETING_ROOM: {
    src: OFFICIAL_MEDIA.studio,
    alt: "TRACE Idea Studio arranged for a focused team session",
  },
  EVENT_SPACE: {
    src: OFFICIAL_MEDIA.bay,
    alt: "A restored TRACE warehouse bay staged for a live event",
  },
  AUDITORIUM: {
    src: OFFICIAL_MEDIA.bay,
    alt: "A restored TRACE warehouse bay staged for a live event",
  },
  OFFICE: {
    src: OFFICIAL_MEDIA.privateOffices,
    alt: "A naturally lit shared workspace inside TRACE Expert City",
  },
};

const spaceEditorialMedia: Record<string, EditorialImage[]> = {
  "TRC-MR-02": [
    {
      src: OFFICIAL_MEDIA.creator,
      alt: "Creator Space at TRACE Expert City during an interactive presentation",
    },
    {
      src: OFFICIAL_MEDIA.studio,
      alt: "TRACE Idea Studio set for a collaborative workshop",
    },
    {
      src: OFFICIAL_MEDIA.privateOffices,
      alt: "A bright collaborative table inside TRACE Expert City",
    },
  ],
  "TRC-MR-01": [
    {
      src: OFFICIAL_MEDIA.studio,
      alt: "TRACE Idea Studio arranged for a focused team session",
    },
    {
      src: OFFICIAL_MEDIA.privateOffices,
      alt: "A naturally lit meeting environment inside TRACE Expert City",
    },
    {
      src: OFFICIAL_MEDIA.community,
      alt: "A small community gathering inside TRACE Expert City",
    },
  ],
  "TRC-CW-01": [
    {
      src: OFFICIAL_MEDIA.coworking,
      alt: "The active coworking hall inside TRACE Expert City",
    },
    {
      src: OFFICIAL_MEDIA.privateOffices,
      alt: "A bright shared work table inside TRACE Expert City",
    },
    {
      src: OFFICIAL_MEDIA.longExterior,
      alt: "The restored warehouse bays that house TRACE Expert City's workspaces",
    },
  ],
  "TRC-AUD-01": [
    {
      src: OFFICIAL_MEDIA.bay,
      alt: "A large brick event hall at TRACE staged with conference lighting",
    },
    {
      src: OFFICIAL_MEDIA.eventProduction,
      alt: "A full-scale event production inside a TRACE warehouse bay",
    },
    {
      src: OFFICIAL_MEDIA.startupHall,
      alt: "A seminar and launch programme inside TRACE Expert City",
    },
  ],
  "TRC-CW-02": [
    {
      src: OFFICIAL_MEDIA.privateOffices,
      alt: "A calm, naturally lit workspace inside TRACE Expert City",
    },
    {
      src: OFFICIAL_MEDIA.coworking,
      alt: "The brick-and-steel coworking hall inside TRACE Expert City",
    },
    {
      src: OFFICIAL_MEDIA.longExterior,
      alt: "TRACE Expert City's shaded red-brick warehouse campus",
    },
  ],
};

function isIllustrativeSeedImage(altText: string | null | undefined): boolean {
  return /illustrative rendering/i.test(altText ?? "");
}

function editorialFallback(space: PublicSpace): EditorialImage {
  return (
    spaceEditorialMedia[space.code]?.[0] ??
    categoryMedia[space.category] ?? {
      src: OFFICIAL_MEDIA.longExterior,
      alt: `The TRACE Expert City campus, home to ${space.name}`,
    }
  );
}

export function coverFor(space: PublicSpace): { src: string; alt: string; isVenueImage: boolean } {
  const realImages = space.images.filter(
    (item) => Boolean(item.url) && !isIllustrativeSeedImage(item.altText),
  );
  const image = realImages.find((item) => item.isCover) ?? realImages[0];
  if (image?.url) {
    return {
      src: image.url,
      alt: image.altText || `${space.name} at TRACE Expert City`,
      isVenueImage: true,
    };
  }
  const fallback = editorialFallback(space);
  return {
    src: fallback.src,
    alt: fallback.alt,
    isVenueImage: false,
  };
}

export function galleryFor(space: PublicSpace): Array<EditorialImage & { id: string; isCover: boolean }> {
  const realImages = space.images.filter(
    (item) => Boolean(item.url) && !isIllustrativeSeedImage(item.altText),
  );

  if (realImages.length > 0) {
    return realImages.map((image, index) => ({
      id: String(image.id),
      src: image.url as string,
      alt: image.altText || `${space.name} at TRACE Expert City`,
      isCover: Boolean(image.isCover || index === 0),
    }));
  }

  const images = spaceEditorialMedia[space.code] ?? [editorialFallback(space)];
  return images.map((image, index) => ({
    ...image,
    id: `official-${space.code}-${index}`,
    isCover: index === 0,
  }));
}

export const campusGallery = [
  { src: OFFICIAL_MEDIA.creator, alt: "Creator Space arranged for an intimate presentation", title: "Creator Space", note: "Workshops, training and focused sessions" },
  { src: OFFICIAL_MEDIA.outdoor, alt: "TRACE Outdoor Space and water feature", title: "Outdoor Space", note: "Open-air gatherings and community events" },
  { src: OFFICIAL_MEDIA.studio, alt: "TRACE Idea Studio workshop setup", title: "Idea Studio", note: "Small teams, podcasts and micro-events" },
  { src: OFFICIAL_MEDIA.bay, alt: "A large brick event hall at TRACE staged for a conference", title: "Bay 07", note: "Industrial scale, transformed by production" },
  { src: OFFICIAL_MEDIA.community, alt: "A networking gathering in the Third Place Lobby", title: "Third Place", note: "Conversation, community and connection" },
];
