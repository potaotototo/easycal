import type { CalendarEventView } from './events-api.ts';

export const EVENT_CATEGORIES = [
  'career',
  'internships',
  'technology',
  'entrepreneurship',
  'education',
  'networking',
  'community',
  'volunteering',
  'sports_wellness',
  'arts_culture',
  'social',
  'other',
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export interface UserPreferencesView {
  interestCategories: EventCategory[];
  locationTerms: string[];
}

export const DEFAULT_PREFERENCES: UserPreferencesView = {
  interestCategories: [
    'career',
    'internships',
    'technology',
    'entrepreneurship',
    'networking',
    'community',
  ],
  locationTerms: [],
};

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  career: 'Career',
  internships: 'Internships',
  technology: 'Technology',
  entrepreneurship: 'Entrepreneurship',
  education: 'Education',
  networking: 'Networking',
  community: 'Community',
  volunteering: 'Volunteering',
  sports_wellness: 'Sports & wellness',
  arts_culture: 'Arts & culture',
  social: 'Social',
  other: 'Other',
};

export function eventMatchesPreferences(
  event: CalendarEventView,
  preferences: UserPreferencesView,
): boolean {
  if (!event.categories.some((category) => preferences.interestCategories.includes(category))) {
    return false;
  }
  if (preferences.locationTerms.length === 0) return true;
  const location = `${event.locationName ?? ''} ${event.address ?? ''}`.toLocaleLowerCase();
  return preferences.locationTerms.some((term) => location.includes(term.trim().toLocaleLowerCase()));
}
