import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { ThemePreference } from '../types/models';
import {
  AppColorPalette,
  COURSE_PALETTE_DARK,
  COURSE_PALETTE_LIGHT,
  CourseColorTheme,
  DARK_COLORS,
  LIGHT_COLORS,
} from './colors';

export interface AppThemeValue {
  isDark: boolean;
  preference: ThemePreference;
  colors: AppColorPalette;
  coursePalette: CourseColorTheme[];
}

const ThemeContext = createContext<AppThemeValue>({
  isDark: false,
  preference: 'system',
  colors: LIGHT_COLORS,
  coursePalette: COURSE_PALETTE_LIGHT,
});

export const AppThemeProvider: React.FC<{
  preference?: ThemePreference;
  children: React.ReactNode;
}> = ({ preference = 'system', children }) => {
  const systemScheme = useColorScheme();
  const value = useMemo<AppThemeValue>(() => {
    const isDark =
      preference === 'dark' || (preference === 'system' && systemScheme === 'dark');
    return {
      isDark,
      preference,
      colors: isDark ? DARK_COLORS : LIGHT_COLORS,
      coursePalette: isDark ? COURSE_PALETTE_DARK : COURSE_PALETTE_LIGHT,
    };
  }, [preference, systemScheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useAppTheme(): AppThemeValue {
  return useContext(ThemeContext);
}
