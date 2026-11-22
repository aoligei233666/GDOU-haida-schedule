export const COLORS = {
  oceanDeep: '#0B3954',
  oceanPrimary: '#0284C7',
  oceanLight: '#E0F2FE',
  oceanTint: '#F0F9FF',
  coral: '#F97316',
  coralLight: '#FFEDD5',
  emerald: '#059669',
  emeraldLight: '#D1FAE5',
  amber: '#D97706',
  amberLight: '#FEF3C7',
  danger: '#DC2626',
  dangerLight: '#FEE2E2',
  bg: '#F4F7FA',
  surface: '#FFFFFF',
  border: '#E2E8F0',
  borderLight: '#EEF2F6',
  textPrimary: '#0F172A',
  textSecondary: '#475569',
  textMuted: '#94A3B8',
  white: '#FFFFFF',
};

export interface CourseColorTheme {
  bg: string;
  border: string;
  text: string;
  subtext: string;
}

export const COURSE_PALETTE: CourseColorTheme[] = [
  { bg: '#E0F2FE', border: '#38BDF8', text: '#0C4A6E', subtext: '#0369A1' },
  { bg: '#DCFCE7', border: '#4ADE80', text: '#14532D', subtext: '#15803D' },
  { bg: '#FEF3C7', border: '#FBBF24', text: '#78350F', subtext: '#B45309' },
  { bg: '#EDE9FE', border: '#A78BFA', text: '#4C1D95', subtext: '#6D28D9' },
  { bg: '#FCE7F3', border: '#F472B6', text: '#831843', subtext: '#BE185D' },
  { bg: '#FFEDD5', border: '#FB923C', text: '#7C2D12', subtext: '#C2410C' },
  { bg: '#CCFBF1', border: '#2DD4BF', text: '#134E4A', subtext: '#0F766E' },
  { bg: '#E0E7FF', border: '#818CF8', text: '#312E81', subtext: '#4338CA' },
  { bg: '#F3E8FF', border: '#C084FC', text: '#581C87', subtext: '#7E22CE' },
  { bg: '#ECFCCB', border: '#A3E635', text: '#365314', subtext: '#4D7C0F' },
];
