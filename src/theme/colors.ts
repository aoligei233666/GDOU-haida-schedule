export interface AppColorPalette {
  oceanDeep: string;
  oceanPrimary: string;
  oceanLight: string;
  oceanTint: string;
  coral: string;
  coralLight: string;
  emerald: string;
  emeraldLight: string;
  amber: string;
  amberLight: string;
  danger: string;
  dangerLight: string;
  bg: string;
  surface: string;
  surfaceElevated: string;
  border: string;
  borderLight: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  white: string;
}

export const LIGHT_COLORS: AppColorPalette = {
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
  surfaceElevated: '#F8FAFC',
  border: '#E2E8F0',
  borderLight: '#EEF2F6',
  textPrimary: '#0F172A',
  textSecondary: '#475569',
  textMuted: '#94A3B8',
  white: '#FFFFFF',
};

export const DARK_COLORS: AppColorPalette = {
  oceanDeep: '#061B2E',
  oceanPrimary: '#38BDF8',
  oceanLight: '#0C4A6E',
  oceanTint: '#0F2940',
  coral: '#FB923C',
  coralLight: '#431407',
  emerald: '#34D399',
  emeraldLight: '#064E3B',
  amber: '#FBBF24',
  amberLight: '#451A03',
  danger: '#F87171',
  dangerLight: '#450A0A',
  bg: '#09111E',
  surface: '#111C2E',
  surfaceElevated: '#17253B',
  border: '#23344D',
  borderLight: '#1B2A40',
  textPrimary: '#F1F5F9',
  textSecondary: '#CBD5E1',
  textMuted: '#64748B',
  white: '#FFFFFF',
};

export const COLORS: AppColorPalette = LIGHT_COLORS;

export interface CourseColorTheme {
  bg: string;
  border: string;
  text: string;
  subtext: string;
}

export const COURSE_PALETTE_LIGHT: CourseColorTheme[] = [
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

export const COURSE_PALETTE_DARK: CourseColorTheme[] = [
  { bg: '#0C3554', border: '#38BDF8', text: '#E0F2FE', subtext: '#7DD3FC' },
  { bg: '#0A3B28', border: '#34D399', text: '#DCFCE7', subtext: '#6EE7B7' },
  { bg: '#452A08', border: '#FBBF24', text: '#FEF3C7', subtext: '#FDE68A' },
  { bg: '#2E1A59', border: '#A78BFA', text: '#EDE9FE', subtext: '#C4B5FD' },
  { bg: '#4C1433', border: '#F472B6', text: '#FCE7F3', subtext: '#F9A8D4' },
  { bg: '#4A200C', border: '#FB923C', text: '#FFEDD5', subtext: '#FDBA74' },
  { bg: '#0D3D3A', border: '#2DD4BF', text: '#CCFBF1', subtext: '#5EEAD4' },
  { bg: '#1E2559', border: '#818CF8', text: '#E0E7FF', subtext: '#A5B4FC' },
  { bg: '#3B1659', border: '#C084FC', text: '#F3E8FF', subtext: '#D8B4FE' },
  { bg: '#233B0E', border: '#A3E635', text: '#ECFCCB', subtext: '#BEF264' },
];

export const COURSE_PALETTE: CourseColorTheme[] = COURSE_PALETTE_LIGHT;
